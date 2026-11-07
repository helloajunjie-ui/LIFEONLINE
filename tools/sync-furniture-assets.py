# -*- coding: utf-8 -*-
"""把生成器里的 23 件家具同步写出到 assets/furniture/*.svg。

为什么要这一步：assets/ 下那份是"可读的源"，HTML 里嵌的是同一份 SVG。
只改 HTML 不同步 assets，下次别人翻 assets 会看到旧图，误以为没改。
"""
import importlib.util
import os

spec = importlib.util.spec_from_file_location('gf', 'tools/gen-furniture.py')
gf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gf)

os.makedirs('assets/furniture', exist_ok=True)
n = 0
for name, fn in gf.ITEMS.items():
    svg_str, b = fn()
    path = 'assets/furniture/%s.svg' % name
    open(path, 'w', encoding='utf-8', newline='\n').write(svg_str + '\n')
    n += 1
print('已写出 %d 个 SVG 到 assets/furniture/' % n)
