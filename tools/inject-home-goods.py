# -*- coding: utf-8 -*-
"""把 24 件内联进 HTML 的 FURN_SVG（反引号字符串感知的括号配平定位闭合）。"""
import json, os
ROOT = r'E:\QHTML'
HTML = os.path.join(ROOT, '2.5D小屋.html')
data = json.load(open(os.path.join(ROOT, 'tools', 'home_goods_data.json'), encoding='utf-8'))
s = open(HTML, encoding='utf-8').read()

anchor = 'const FURN_SVG = {'
start = s.find(anchor)
assert start >= 0, '找不到 FURN_SVG'
brace0 = s.find('{', start)

# 反引号/引号感知的括号配平，找到匹配的闭合 }
i = brace0
depth = 0
line = s.count('\n', 0, i) + 1
close = None
while i < len(s):
    c = s[i]
    if c == '`':
        # 跳过整个模板字符串（处理转义反引号）
        i += 1
        while i < len(s):
            if s[i] == '\\':
                i += 2; continue
            if s[i] == '`':
                break
            i += 1
    elif c in ("'", '"'):
        q = c; i += 1
        while i < len(s):
            if s[i] == '\\':
                i += 2; continue
            if s[i] == q:
                break
            i += 1
    elif c == '{':
        depth += 1
    elif c == '}':
        depth -= 1
        if depth == 0:
            close = i; break
    i += 1

assert close is not None, 'FURN_SVG 括号未配平'
# 防重复注入
for id in data:
    assert ('  %s: {w:' % id) not in s, '已存在条目 %s，勿重复注入' % id

block = []
for id, d in data.items():
    block.append('  %s: {w:%d, h:%d, ax:%d, ay:%d, svg:\n`%s`},\n'
                 % (id, d['w'], d['h'], d['ax'], d['ay'], d['svg']))
block = ''.join(block)
# 闭合 } 前需要一个换行衔接
prefix = s[:close]
if not prefix.endswith('\n'):
    block = '\n' + block
new = s[:close] + block + s[close:]
open(HTML, 'w', encoding='utf-8', newline='').write(new)
print('已注入 %d 件，FURN_SVG 闭合于第 %s 行附近，新文件 %d 字符'
      % (len(data), s.count('\n', 0, close), len(new)))
