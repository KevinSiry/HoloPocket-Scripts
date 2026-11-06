import pathlib, re, subprocess, sys

SRC = pathlib.Path(__file__).resolve().parent
OUT = SRC.parent / 'scripts'
REPO = OUT
RAW = 'https://raw.githubusercontent.com/KevinSiry/HoloPocket-Scripts/main/scripts/'
REPO.mkdir(parents=True, exist_ok=True)
kit = (SRC / 'kit.js').read_text(encoding='utf-8')

# Harmonisation des couleurs codées en dur avec les variables du site
COLORS = [
    ("'#1c1c1c'", "'var(--color-panel,#18181b)'"), ('#1c1c1c', 'var(--color-panel,#18181b)'),
    ('background:#222', 'background:var(--color-panel-2,#242428)'),
    ('#333', 'var(--color-line,#313136)'), ('#444', 'var(--color-line,#313136)'), ('#555', 'var(--color-line,#313136)'),
    ('#aaa', 'var(--color-muted,#9d9da3)'), ('#888', 'var(--color-muted,#9d9da3)'), ('#777', 'var(--color-muted,#9d9da3)'),
    ('#ccc', 'var(--color-muted,#9d9da3)'), ('#9ad', 'var(--color-muted,#9d9da3)'),
    ('#f2f2f2', 'var(--color-ink,#f4f4f1)'), ('#ffd400', 'var(--color-brand,#ffd60a)'),
    ('#7ee0a1', '#4ade80'), ('#1f9d55', '#22c55e'), ('#f88', '#f87171'), ('#c0392b', '#ef4444'),
    ('#e67e22', '#fb923c'), ('#f0b060', '#fb923c'), ('#b7950b', '#ca8a04'), ('#b8860b', '#ca8a04'),
    ('system-ui, sans-serif', 'var(--font-sans, system-ui, sans-serif)'),
    ('system-ui,sans-serif', 'var(--font-sans,system-ui,sans-serif)'),
]

ok = True
for f in sorted(SRC.glob('holopocket-*.user.js')):
    text = f.read_text(encoding='utf-8')
    if '/*__HPUI_KIT__*/' not in text:
        print('PAS DE KIT :', f.name); ok = False; continue
    head, body = text.split('/*__HPUI_KIT__*/', 1)
    for a, b in COLORS:
        head = head.replace(a, b)
        body = body.replace(a, b)
    # ne pas remplacer dans le kit lui-même
    out = head + kit.strip('\n') + '\n' + body
    # Mise à jour automatique par Tampermonkey depuis GitHub
    if '@updateURL' not in out:
        import re as _re
        out = _re.sub(r'(// @version[^\n]*\n)', lambda m: m.group(1) + f'// @updateURL    {RAW}{f.name}\n// @downloadURL  {RAW}{f.name}\n', out, count=1)
    (REPO / f.name).write_text(out, encoding='utf-8')
    (OUT / f.name).write_text(out, encoding='utf-8')
    r = subprocess.run(['node', '--check', str(OUT / f.name)], capture_output=True, text=True)
    print(('OK   ' if r.returncode == 0 else 'ERR  ') + f.name + ('' if r.returncode == 0 else '\n' + r.stderr[:600]))
    ok = ok and r.returncode == 0
sys.exit(0 if ok else 1)
