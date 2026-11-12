# 数值体检：0-100 的三条状态，把所有增减来源按"每天需要补多少 / 一次能补多少"对齐
# 用法：python tools/stataudit.py   （改 survival.json 的衰减之前先跑一遍）
import json, io, os, glob

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def pack(rel):
    with io.open(os.path.join(root, 'content', rel), encoding='utf-8') as f:
        return json.load(f)

sv = pack('rules/survival.json')
ST = sv['stats']
stats = ['hunger', 'thirst', 'emotion']
LABEL = {k: ST[k]['label'] for k in stats}
MAX = {k: ST[k]['max'] for k in stats}
DECAY = {k: ST[k]['decayPerGameMinute'] for k in stats}
DAY_MIN = 1440
rate = sv['clock'].get('worldRate', 60)
real_min_per_day = DAY_MIN / rate

print('== 每天会被消耗掉多少（1 游戏日 = %d 游戏分钟 = %.0f 真实分钟）' % (DAY_MIN, real_min_per_day))
for k in stats:
    d = DECAY[k] * DAY_MIN
    print('  %-6s 衰减 %.3f/游戏分钟 → 每天 -%.1f（占满格 %.0f%%）' % (LABEL[k], DECAY[k], d, d / MAX[k] * 100))

# 固定开销：睡觉
sl = sv.get('sleep', {}).get('cost', {})
print('  固定开销：睡觉 -%s / -%s' % (sl.get('hunger', 0), sl.get('thirst', 0)))

# ---- 收集所有"正向补充"来源 ----
srcs = []   # (来源, {stat: delta})

def add(name, eff, note=''):
    got = {k: v for k, v in (eff or {}).items() if k in stats and isinstance(v, (int, float)) and v}
    if got:
        srcs.append((name + ((' · ' + note) if note else ''), got))

# 三餐（economy.food）
eco = pack('rules/economy.json')
for key in ('cook', 'meal', 'snack'):
    f = eco['food'].get(key)
    if f:
        add('自家' + f.get('label', key), {k: v for k, v in f.items() if k in stats}, '耗 %s 份' % f.get('uses', 0))

# 下馆子
for d in eco['restaurant']['menu']:
    add('饭馆·' + d['name'], {k: d.get(k, 0) for k in stats}, '¥%d' % d['price'])

# 超市货架
for g in eco['mart'].get('goods', []):
    add('超市·' + g.get('name', g.get('id', '?')), {k: g.get(k, 0) for k in stats}, '¥%d' % g.get('price', 0))

# 医院
for s in eco.get('clinic', {}).get('services', []) or eco.get('clinic', {}).get('list', []):
    add('门诊·' + s.get('name', '?'), s.get('effects', {}), '¥%d' % s.get('price', 0))

# 家具交互（catalog 里的 acts[].effects）
for rel in glob.glob(os.path.join(root, 'content', 'catalog', '*.json')):
    c = json.load(io.open(rel, encoding='utf-8'))
    for it in c.get('items', []):
        for a in (it.get('interaction', {}) or {}).get('acts', []) or []:
            add('%s·%s' % (it.get('name', it['id']), a.get('label', a.get('verb', ''))), a.get('effects', {}))
        ix = it.get('interaction') or {}
        if ix.get('effects') and ix.get('verb'):
            add('%s·%s' % (it.get('name', it['id']), ix.get('label', ix['verb'])), ix['effects'])

# ---- 按“一次补多少”排序 ----
print('\n== 单次补充幅度（占满格 %）')
rows = []
for name, got in srcs:
    for k, v in got.items():
        rows.append((k, v / MAX[k] * 100, v, name))
rows.sort(key=lambda r: (stats.index(r[0]), -r[1]))
for k in stats:
    sub = [r for r in rows if r[0] == k]
    if not sub:
        print('  %-6s ★ 没有任何补充来源！' % LABEL[k])
        continue
    print('  %s：' % LABEL[k])
    for _, pct, v, name in sub[:14]:
        flag = ''
        if pct >= 60: flag = '  ← 一次补六成以上，几乎等于清空重来'
        elif pct < 5: flag = '  ← 太小，补了等于没补'
        print('    %+4d（%5.1f%%）  %s%s' % (v, pct, name, flag))
    rest = sub[14:]
    if rest:
        print('    …… 另有 %d 条更小的（最大 %+.0f）' % (len(rest), rest[0][2]))

# ---- 每天要吃几次 ----
print('\n== 要维持满格，一天需要做几次')
for k in stats:
    sub = [r[2] for r in rows if r[0] == k and r[2] > 0]
    if not sub:
        print('  %-6s 无法维持' % LABEL[k]); continue
    need = DECAY[k] * DAY_MIN
    sub.sort()
    best = sub[-1]
    avg = sum(sub) / len(sub)
    print('  %-6s 每天需补 %5.1f → 用最大单次(%+.0f)要 %.1f 次，用平均(%+.1f)要 %.1f 次'
          % (LABEL[k], need, best, need / best, avg, need / avg))
