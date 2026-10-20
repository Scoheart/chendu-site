#!/usr/bin/env python3
"""晨读 static-site generator.

Usage:
  python tools/build.py                   # render every issues/*/data.json + rebuild index.html
  python tools/build.py --tts 2026-10-09  # (re)generate audio.mp3 + audio-slow.mp3 for one issue, then render
  python tools/build.py --check           # only validate data files (anchors, overlaps, audio files)

Requires Python 3.9+. Optional: edge-tts (for --tts), fonttools+brotli (handwriting font subsets), ffprobe (durations).
"""
import argparse, asyncio, hashlib, html, json, re, string, subprocess, sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ISSUES = ROOT / "issues"
FONT_SRC_ZH = ROOT / "tools" / "fonts" / "MaShanZheng-Regular.ttf"
FONT_SRC_EN = ROOT / "tools" / "fonts" / "Caveat.ttf"
SITE_NAME = "晨读"
SITE_TAGLINE = "每天一篇真实英文 · 美股 × AI 轮换 · 手写批注精读"
TYPE_LABEL = {"vocab": "词汇", "grammar": "语法", "idiom": "地道表达"}
TOPIC_LABEL = {"stocks": "美股", "ai": "AI 技术"}
WEEKDAY_ZH = "一二三四五六日"


def esc(s):
    return html.escape(str(s), quote=True)


def md_lite(s):
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", esc(s))


_ABBR_TAIL = re.compile(r"(?:U\.S|U\.K|e\.g|i\.e|Mr|Mrs|Ms|Dr)$")
_EXAMPLE_LABEL = re.compile(r"例(?:如|句)?[:：]\s*")
_ONLY_PAREN = re.compile(r"^[（(][^）)]*[）)]$")


def _cjk(ch):
    return "\u4e00" <= ch <= "\u9fff"


def _zh_sentences(s):
    """Split on 。！？, but not on a period inside （） or ()."""
    parts, buf, depth = [], [], 0
    for ch in s:
        if ch in "（(":
            depth += 1
        elif ch in "）)" and depth:
            depth -= 1
        buf.append(ch)
        if depth == 0 and ch in "。！？":
            parts.append("".join(buf).strip())
            buf = []
    tail = "".join(buf).strip()
    if tail:
        parts.append(tail)
    return [p for p in parts if p]


def _english_example_spans(s):
    """Full English sentences (3+ words). Decimals (5.8%) and U.S. are not endings."""
    spans, i, n = [], 0, len(s)
    while i < n:
        ch = s[i]
        if ch.isascii() and ch.isupper() and (i == 0 or not (s[i - 1].isalpha() or s[i - 1] in "'’")):
            j = i
            while j < n:
                c = s[j]
                if c in ".!?":
                    nxt = s[j + 1] if j + 1 < n else ""
                    if nxt.isalpha() or nxt.isdigit():
                        j += 1
                        continue
                    k = j + 1
                    while k < n and s[k] in " \t":
                        k += 1
                    nxt2 = s[k] if k < n else ""
                    prev = s[max(i, j - 4):j]
                    if nxt2.islower() or _ABBR_TAIL.search(prev):
                        j += 1
                        continue
                    words = re.findall(r"[A-Za-z][A-Za-z'’\-]*", s[i:j + 1])
                    if len(words) >= 3 and (nxt2 == "" or _cjk(nxt2) or nxt2 in "，；。！？（(" or nxt2.isupper()):
                        spans.append((i, j + 1))
                        i = j
                        break
                if _cjk(c) or c in "，；：、":
                    break
                j += 1
        i += 1
    return spans


def _explode_example(sent):
    """Pull an English example sentence onto its own line when Chinese shares the sentence."""
    spans = _english_example_spans(sent)
    if not spans:
        return [sent]
    a, b = spans[0]
    before, eng, after = sent[:a].strip(), sent[a:b].strip(), sent[b:].strip()
    label = _EXAMPLE_LABEL.fullmatch(before or "")
    if label:
        eng = before + eng
        before = ""
    if _ONLY_PAREN.fullmatch(after or ""):
        eng = eng + after
        after = ""
    out = []
    if before:
        out.append(before)
    out.append(eng)
    if after:
        out.extend(_explode_example(after))
    return out


def _is_example_line(text):
    t = text.strip()
    if t.startswith("例：") or t.startswith("例:") or t.startswith("例如") or t.startswith("例句"):
        return True
    if re.match(r"[“\"']?[A-Z]", t):
        words = re.findall(r"[A-Za-z][A-Za-z'’\-]*", t)
        if len(words) >= 3 and re.search(r"[.!?]", t):
            return True
    return False


def note_zh_html(s):
    """Each gloss sentence on its own line; English example sentences get `.nz-ex`."""
    lines = []
    for sent in _zh_sentences(s):
        lines.extend(_explode_example(sent))
    return "".join(
        f'<span class="nz-line nz-ex">{md_lite(line)}</span>' if _is_example_line(line)
        else f'<span class="nz-line">{md_lite(line)}</span>'
        for line in lines)


def load_issues():
    out = []
    for f in sorted(ISSUES.glob("*/data.json")):
        d = json.loads(f.read_text("utf-8"))
        d["_dir"] = f.parent
        out.append(d)
    out.sort(key=lambda d: d["date"])
    return out


# ------------------------------------------------------------ validation
def validate(d):
    errs, secs = [], d["article"]["sections"]
    by_para = {}
    for i, n in enumerate(d["notes"]):
        s, p = n["p"]
        try:
            para = secs[s][p]
        except (IndexError, TypeError):
            errs.append(f"note {i+1}: bad paragraph index {n['p']}")
            continue
        k = para.find(n["anchor"])
        if k < 0:
            errs.append(f"note {i+1}: anchor not found in para {n['p']}: {n['anchor']!r}")
        else:
            by_para.setdefault((s, p), []).append((k, k + len(n["anchor"]), i))
        if n.get("type") not in TYPE_LABEL:
            errs.append(f"note {i+1}: unknown type {n.get('type')}")
    for key, spans in by_para.items():
        spans.sort()
        for a, b in zip(spans, spans[1:]):
            if b[0] < a[1]:
                errs.append(f"notes {a[2]+1} and {b[2]+1} overlap in para {list(key)}")
    for k in ("normal", "slow"):
        fn = d.get("audio", {}).get(k)
        if fn and not (d["_dir"] / fn).exists():
            errs.append(f"audio file missing: {fn} (run --tts {d['date']})")
    return errs


# ------------------------------------------------------------ TTS
def tts_text(d):
    paras = [p for sec in d["article"]["sections"] for p in sec]
    text = "\n\n".join(paras).replace("NEW YORK (AP) —", "New York, A.P.")
    return d["article"]["title"] + ".\n\n" + text


async def _tts(text, voice, rate, out):
    import edge_tts
    await edge_tts.Communicate(text, voice, rate=rate).save(str(out))


def _tts_gtts(text, slow, out):
    """Fallback when Microsoft edge-tts returns 403 / handshake errors."""
    from gtts import gTTS
    from io import BytesIO
    # gTTS has ~100-char soft limits per request in practice for reliability; chunk by paragraph
    parts = [p.strip() for p in text.split("\n\n") if p.strip()] or [text]
    buf = BytesIO()
    for i, part in enumerate(parts):
        # keep each request under ~4500 chars
        chunks = [part[j:j+4000] for j in range(0, len(part), 4000)] or [part]
        for chunk in chunks:
            tts = gTTS(text=chunk, lang="en", tld="com", slow=slow)
            tts.write_to_fp(buf)
    out.write_bytes(buf.getvalue())


def make_tts(d):
    au = d.setdefault("audio", {})
    voice = au.setdefault("voice", "en-US-AriaNeural")
    au.setdefault("normal", "audio.mp3")
    au.setdefault("slow", "audio-slow.mp3")
    text = tts_text(d)
    normal = d["_dir"] / au["normal"]
    slow = d["_dir"] / au["slow"]
    try:
        asyncio.run(_tts(text, voice, "+0%", normal))
        asyncio.run(_tts(text, voice, "-20%", slow))
    except Exception as e:
        print("edge-tts failed (%s); falling back to gTTS" % (type(e).__name__,))
        _tts_gtts(text, slow=False, out=normal)
        _tts_gtts(text, slow=True, out=slow)
        au["voice"] = "gTTS-en"
    print("TTS written:", au)


def duration(path):
    try:
        r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                            "-of", "csv=p=0", str(path)], capture_output=True, text=True)
        return float(r.stdout.strip())
    except Exception:
        # no ffprobe (e.g. Vercel build image): edge-tts writes 48 kbps CBR mp3
        try:
            return path.stat().st_size * 8 / 48000
        except Exception:
            return None


def fmt_dur(sec):
    if not sec:
        return ""
    sec = int(round(sec))
    return f"{sec // 60}:{sec % 60:02d}"


# ------------------------------------------------------------ fonts
def subset_font(src, text, out):
    """Subset a font to the characters used (woff2) so it is tiny and self-hosted (Google Fonts is slow/blocked in CN)."""
    if not src.exists():
        return out.exists()
    try:
        from fontTools import subset
    except ImportError:
        print("! fonttools not installed – skipping font subset", out.name)
        return out.exists()
    opts = subset.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["*"]
    font = subset.load_font(str(src), opts)
    sub = subset.Subsetter(opts)
    sub.populate(text="".join(sorted(set(text + string.printable))))
    sub.subset(font)
    out.parent.mkdir(parents=True, exist_ok=True)
    subset.save_font(font, str(out), opts)
    return True


def ensure_en_font():
    out = ROOT / "assets" / "fonts" / "caveat.woff2"
    if not out.exists():
        subset_font(FONT_SRC_EN, string.printable + "’‘“”—–…·→←×é", out)


# ------------------------------------------------------------ rendering
def asset_url(rel, name):
    """assets/* are served with max-age=86400, so the URL carries a content hash to bust stale caches."""
    f = ROOT / "assets" / name
    v = hashlib.sha1(f.read_bytes()).hexdigest()[:10] if f.exists() else "0"
    return f"{rel}assets/{name}?v={v}"


def head(title, desc, rel, zh_font_url):
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(title)}</title>
<meta name="description" content="{esc(desc)}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%93%96%3C/text%3E%3C/svg%3E">
<style>
@font-face{{font-family:"Caveat";src:url("{asset_url(rel, 'fonts/caveat.woff2')}") format("woff2");font-display:swap;font-weight:400 700}}
@font-face{{font-family:"ZhHand";src:url("{zh_font_url}") format("woff2");font-display:swap}}
</style>
<link rel="stylesheet" href="{asset_url(rel, 'style.css')}">
</head>
"""


def date_zh(ds):
    y, m, dd = map(int, ds.split("-"))
    return f"{y} 年 {m} 月 {dd} 日 · 周{WEEKDAY_ZH[date(y, m, dd).weekday()]}"


def render_para(text, here):
    spans = sorted((text.find(n["anchor"]), num, n) for num, n in here)
    out, pos = [], 0
    for a, num, n in spans:
        b = a + len(n["anchor"])
        out.append(esc(text[pos:a]))
        out.append(f'<mark class="hl t-{n["type"]}" data-n="{num}" tabindex="0" role="button" '
                   f'aria-controls="note-{num}">{esc(text[a:b])}<sup>{num}</sup></mark>')
        pos = b
    out.append(esc(text[pos:]))
    return "".join(out)


def render_note(num, n):
    tilt = [-1.2, 0.8, -0.5, 1.1, -0.9, 0.4][num % 6]
    return (f'<div class="note t-{n["type"]}" id="note-{num}" data-n="{num}" style="--tilt:{tilt}deg">'
            f'<span class="num">{num}</span><span class="tag">{TYPE_LABEL[n["type"]]}</span>'
            f'<div class="nh">{esc(n["head"])}</div><div class="nz">{note_zh_html(n["zh"])}</div></div>')


def render_recall(order, notes, num_of):
    """Checklist of every margin note, in reading order, for recall at the end of the issue."""
    items = []
    for i in order:
        n, num = notes[i], num_of[i]
        items.append(
            f'<li class="recall-item t-{n["type"]}" data-head="{esc(n["head"])}">'
            f'<label class="recall-tick"><input type="checkbox" aria-label="已记住 {esc(n["head"])}"></label>'
            f'<a class="recall-num" href="#note-{num}" data-n="{num}">{num}</a>'
            f'<div class="recall-main"><button type="button" class="recall-q" aria-expanded="false">'
            f'<span class="tag">{TYPE_LABEL[n["type"]]}</span>'
            f'<span class="recall-head">{esc(n["head"])}</span></button>'
            f'<div class="recall-zh">{note_zh_html(n["zh"])}</div></div></li>')
    return ('<section class="block recall" id="recall"><h2 class="hand">批注回顾</h2>'
            '<p class="hint recall-hint">先盖住释义，看着单词和短语自己回忆。点词条看释义，点序号回到原文。勾选只存在这台浏览器里。</p>'
            '<div class="recall-bar"><span class="recall-count" id="recall-count"></span>'
            '<button type="button" class="toggle" id="recall-reset">清空勾选</button></div>'
            f'<ol class="recall-list">{"".join(items)}</ol></section>')


def render_issue(d, prev_d, next_d):
    a, dirp, notes = d["article"], d["_dir"], d["notes"]
    order = sorted(range(len(notes)), key=lambda i: (notes[i]["p"][0], notes[i]["p"][1],
                   a["sections"][notes[i]["p"][0]][notes[i]["p"][1]].find(notes[i]["anchor"])))
    num_of = {i: k + 1 for k, i in enumerate(order)}

    body, flip = [], 0
    for s, sec in enumerate(a["sections"]):
        if s > 0:
            body.append('<div class="gap" title="中间段落省略">[ … ]</div>')
        for p, text in enumerate(sec):
            here = [(num_of[i], notes[i]) for i in order if notes[i]["p"] == [s, p]]
            left, right = [], []
            for num, n in here:
                (left if flip % 2 == 0 else right).append(render_note(num, n))
                flip += 1
            body.append(f'<div class="row"><p class="para">{render_para(text, here)}</p>'
                        f'<aside class="side left">{"".join(left)}</aside>'
                        f'<aside class="side right">{"".join(right)}</aside></div>')

    au, audio_html = d.get("audio", {}), ""
    for key, label in (("normal", "🎧 正常语速"), ("slow", "🐢 慢速 0.8×")):
        fn = au.get(key)
        if fn and (dirp / fn).exists():
            audio_html += (f'<div class="player"><div class="pl">{label} <small>{esc(au.get("voice", ""))} · '
                           f'{fmt_dur(duration(dirp / fn))}</small></div>'
                           f'<audio controls preload="metadata" src="{esc(fn)}"></audio></div>')
    if audio_html:
        audio_html = ('<section class="block"><h2 class="hand">听 · 朗读音频</h2>'
                      '<p class="hint">AI 合成朗读（TTS）。建议先不看原文盲听一遍，再对照原文跟读。</p>'
                      f'{audio_html}</section>')

    say = lambda t, lab="朗读": f'<button class="say" data-say="{esc(t)}" aria-label="{lab}">🔊</button>'
    words = "".join(
        f'<tr><td class="w">{say(w["word"])}<b>{esc(w["word"])}</b><div class="ipa">{esc(w["ipa"])}</div></td>'
        f'<td class="zh">{esc(w["zh"])}</td><td class="ex">{say(w["example"])}{esc(w["example"])}</td></tr>'
        for w in d["review_words"])
    pats = "".join(
        f'<li><div class="pat">{esc(x["pattern"])} <span>{esc(x["zh"])}</span></div>'
        f'<div class="from">原文：{esc(x["from"])}</div>'
        f'<div class="model">{say(x["model"])}{esc(x["model"])}</div>'
        f'<div class="modelzh">{esc(x["model_zh"])}</div></li>' for x in d["patterns"])

    pod = ""
    if d.get("podcast"):
        pc = d["podcast"]
        pod = (f'<section class="block"><h2 class="hand">延伸收听 · 播客</h2>'
               f'<a class="podcast" href="{esc(pc["url"])}" target="_blank" rel="noopener">'
               f'<div class="ps">{esc(pc["show"])} · {esc(pc["date"])}</div>'
               f'<div class="pt">{esc(pc["title"])} ↗</div><div class="pz">{esc(pc["zh"])}</div></a></section>')

    alt = " · ".join(f'<a href="{esc(x["url"])}" target="_blank" rel="noopener">{esc(x["label"])}</a>'
                     for x in a.get("alt_urls", []))
    nav = ('<nav class="pn">' +
           (f'<a href="../{prev_d["date"]}/">← {prev_d["date"]}</a>' if prev_d else '<span></span>') +
           '<a href="../../">全部往期</a>' +
           (f'<a href="../{next_d["date"]}/">{next_d["date"]} →</a>' if next_d else '<span></span>') + '</nav>')
    legend = ('<div class="legend"><span class="lg t-vocab">词汇</span><span class="lg t-grammar">语法</span>'
              '<span class="lg t-idiom">地道表达</span><span class="lg t-user">我的笔记</span>'
              '<button id="toggle-all" class="toggle">展开全部笔记</button>'
              '<span class="mhint">👆 点彩色划线看笔记</span>'
              '<span class="uhint">✏️ 选中标题或原文即可加自己的笔记</span></div>')
    mynotes = ('<section class="block mynotes" id="mynotes" hidden><h2 class="hand">我的笔记</h2>'
               '<p class="hint">只保存在这台设备的浏览器里（localStorage），不会上传。</p>'
               '<div class="mn-body"></div></section>')

    recall = render_recall(order, notes, num_of)
    ui_text = (SITE_NAME + SITE_TAGLINE + "听朗读音频复习词可以模仿的句型延伸收听播客全部往期正常语速慢速今日精读"
               "我的笔记批注回顾")
    # Margin notes, markers, and note hints use --sans. Keep ZhHand for the brand, lead, and section headings.
    hand_src = {k: v for k, v in d.items() if k not in ("_dir", "notes")}
    subset_font(FONT_SRC_ZH, json.dumps(hand_src, ensure_ascii=False) + ui_text, dirp / "zh-hand.woff2")

    page = head(f"{a['title']} · {SITE_NAME} {d['date']}", d.get("issue_title_zh", ""), "../../", "zh-hand.woff2") + f"""<body class="issue" data-issue="{esc(d['date'])}">
<header class="top"><a class="brand hand-zh" href="../../">{SITE_NAME}</a><span class="date">{date_zh(d['date'])}</span></header>
<main>
<div class="meta-wrap">
<div class="kicker"><span class="topic t-{esc(d['topic'])}">{esc(TOPIC_LABEL.get(d['topic'], d['topic']))}</span><span class="hand-zh">今日精读</span></div>
<h1 class="title">{esc(a['title'])}</h1>
<p class="zh-title">{esc(d.get('issue_title_zh', ''))}</p>
<p class="byline">By <b>{esc(a['author'])}</b> · {esc(a['source'])} · {esc(a['published'])}</p>
<p class="lead hand-zh">{esc(d.get('lead_zh', ''))}</p>
{legend}
</div>
<article class="article">
{''.join(body)}
</article>
<div class="meta-wrap">
<p class="credit">{esc(a['excerpt_note'])}<br>原文链接：<a href="{esc(a['url'])}" target="_blank" rel="noopener">{esc(a.get('url_label', '原文'))}</a>{(' · ' + alt) if alt else ''}</p>
</div>
<div class="bottom">
{recall}
{audio_html}
<section class="block"><h2 class="hand">复习词</h2><div class="tw"><table class="words"><tbody>{words}</tbody></table></div></section>
<section class="block"><h2 class="hand">可以模仿的句型</h2><ol class="patterns">{pats}</ol></section>
{pod}
{mynotes}
{nav}
</div>
</main>
<footer class="foot">{SITE_NAME} · 中文讲解为原创学习笔记；英文原文版权归原作者及媒体所有</footer>
<script src="{asset_url('../../', 'sync.js')}" defer></script>
<script src="{asset_url('../../', 'issue.js')}" defer></script>
</body>
</html>
"""
    (dirp / "index.html").write_text(page, "utf-8")
    print("rendered", (dirp / "index.html").relative_to(ROOT))


def render_index(issues):
    hero = ""
    if issues:
        L = issues[-1]
        a = L["article"]
        hero = f"""<a class="hero" href="issues/{L['date']}/">
<div class="kicker"><span class="topic t-{esc(L['topic'])}">{esc(TOPIC_LABEL.get(L['topic'], L['topic']))}</span><span class="hand-zh">最新一期 · {date_zh(L['date'])}</span></div>
<h2 class="title">{esc(a['title'])}</h2>
<p class="zh-title">{esc(L.get('issue_title_zh', ''))}</p>
<p class="lead hand-zh">{esc(L.get('lead_zh', ''))}</p>
<p class="byline">{esc(a['source'])} · {len(L['notes'])} 条批注 · {len(L['review_words'])} 个复习词 <span class="go hand-zh">开始读 →</span></p>
</a>"""
    rows = "".join(
        f'<li><a href="issues/{d["date"]}/"><span class="d">{d["date"]}</span>'
        f'<span class="topic t-{esc(d["topic"])}">{esc(TOPIC_LABEL.get(d["topic"], d["topic"]))}</span>'
        f'<span class="t">{esc(d["article"]["title"])}<small>{esc(d.get("issue_title_zh", ""))}</small></span></a></li>'
        for d in reversed(issues))
    # Home titles and the byline use --sans. ZhHand still covers the brand, tagline, date kicker, and lead.
    text = SITE_NAME + SITE_TAGLINE + "往期最新一期开始读周一二三四五六日年月" + "".join(
        date_zh(d["date"]) + (d.get("lead_zh") or "") for d in issues)
    subset_font(FONT_SRC_ZH, text, ROOT / "assets" / "fonts" / "zh-hand-index.woff2")
    page = head(f"{SITE_NAME} · 每日英文精读", SITE_TAGLINE, "", asset_url("", "fonts/zh-hand-index.woff2")) + f"""<body class="home">
<header class="masthead"><h1 class="brand hand-zh">{SITE_NAME}</h1><p class="tag hand-zh">{SITE_TAGLINE}</p></header>
<main class="home-main">
{hero}
<section class="archive"><h2 class="hand-zh">往期</h2><ul>{rows}</ul></section>
</main>
<footer class="foot">{SITE_NAME} · 英文原文版权归原作者及媒体所有，本站仅节选用于个人学习</footer>
<script src="{asset_url('', 'sync.js')}" defer></script>
</body>
</html>
"""
    (ROOT / "index.html").write_text(page, "utf-8")
    print("rendered index.html with", len(issues), "issue(s)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tts", metavar="DATE")
    ap.add_argument("--tts-missing", action="store_true",
                    help="generate TTS for every issue whose mp3 files are missing (used by the Vercel build)")
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    issues = load_issues()
    if args.tts:
        m = [d for d in issues if d["date"] == args.tts]
        if not m:
            sys.exit(f"no issue {args.tts}")
        make_tts(m[0])
    if args.tts_missing:
        for d in issues:
            au = d.get("audio", {})
            if not all((d["_dir"] / au.get(k, f)).exists() for k, f in (("normal", "audio.mp3"), ("slow", "audio-slow.mp3"))):
                make_tts(d)
    errs = [f"[{d['date']}] {e}" for d in issues for e in validate(d)]
    if errs:
        print("\n".join(errs))
        sys.exit("validation failed")
    if args.check:
        print("ok:", len(issues), "issue(s)")
        return
    ensure_en_font()
    for i, d in enumerate(issues):
        render_issue(d, issues[i - 1] if i else None, issues[i + 1] if i + 1 < len(issues) else None)
    render_index(issues)


if __name__ == "__main__":
    main()
