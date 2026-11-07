# -*- coding: utf-8 -*-
"""
从 home_goods_data.json（几何）+ META（业务数据）生成
content/catalog/home.goods.json，并把该包注册进 manifest.json。
几何（size/anchor）直接取实际 SVG，杜绝手工错位。
"""
import json, os
ROOT = r'E:\QHTML'
geom = json.load(open(os.path.join(ROOT, 'tools', 'home_goods_data.json'), encoding='utf-8'))

# id: (name, category, price, cozy, footW, footH, verb, effects, tags, desc)
META = [
 ('washer','洗衣机','appliance',380,3,1,1,'laundry',{'emotion':5},['electric','water'],'洗衣服，焕然一新'),
 ('microwave','微波炉','appliance',220,2,1,1,'snack',{'hunger':16},['electric','food'],'快速加热，补充饥饿'),
 ('oven','烤箱','appliance',420,3,2,1,'cook',{'hunger':26},['electric','food'],'烘焙烹饪，大幅补饥饿'),
 ('dishwasher','洗碗机','appliance',300,2,1,1,'rest',{'emotion':3},['electric','water'],'自动洗碗，省心'),
 ('coffee','咖啡机','appliance',240,2,1,1,'brew',{'thirst':14,'emotion':3},['electric'],'冲一杯咖啡，提神'),
 ('waterdisp','饮水机','appliance',200,2,1,1,'drink',{'thirst':30},['electric','water'],'冷热饮水，快速解渴'),
 ('ricecooker','电饭煲','appliance',180,2,1,1,'eat',{'hunger':22},['electric','food'],'焖饭煮粥，补充饥饿'),
 ('aircon','立式空调','appliance',520,4,1,1,'rest',{'emotion':4},['electric'],'调节室温，舒适自在'),
 ('robotvac','扫地机器人','appliance',280,1,1,1,'rest',{'emotion':2},['electric'],'自动清扫，解放双手'),
 ('kettle','电热水壶','appliance',120,1,1,1,'drink',{'thirst':18},['electric','water'],'烧水煮茶，补充口渴'),
 ('toaster','烤面包机','appliance',150,1,1,1,'snack',{'hunger':14},['electric','food'],'烤出香脆面包'),
 ('desk','书桌','furniture',240,3,2,1,'read',{'emotion':5},['comfort'],'看书工作，配电脑'),
 ('chair','办公椅','furniture',120,2,1,1,'rest',{'emotion':3},['comfort'],'坐下休息，配书桌'),
 ('coffeetable','茶几','furniture',140,2,2,1,'rest',{'emotion':2},['comfort'],'沙发区小桌'),
 ('tvstand','电视柜','furniture',180,2,2,1,None,None,[],'摆放电视，收纳杂物'),
 ('nightstand','床头柜','furniture',100,2,1,1,'rest',{'emotion':2},['comfort'],'床边小柜，随手置物'),
 ('vanity','梳妆台','furniture',260,3,2,1,None,None,[],'对镜梳妆，精致一天'),
 ('shower','淋浴间','furniture',360,4,2,1,'shower',{'emotion':7},['water','comfort'],'快速淋浴，清爽提神'),
 ('washbasin','洗手台','furniture',160,2,1,1,'drink',{'thirst':12},['water'],'洗漱洗手，整理仪容'),
 ('shoecab','鞋柜','furniture',140,1,1,1,None,None,[],'收纳鞋子，玄关整洁'),
 ('kitcab','橱柜','furniture',200,2,1,1,None,None,[],'厨房收纳，碗碟归位'),
 ('mirror','落地穿衣镜','decor',120,2,1,1,None,None,['decor'],'整理穿搭，点亮房间'),
 ('floorlamp','落地灯','decor',150,2,1,1,None,None,['decor'],'柔和照明，温馨氛围'),
 ('gfclock','落地座钟','decor',220,3,1,1,None,None,['decor'],'滴答作响，典雅摆设'),
]

items = []
for (id,name,cat,price,cozy,fw,fh,verb,effects,tags,desc) in META:
    g = geom[id]
    it = {
        'id': id, 'name': name, 'category': cat, 'tags': tags,
        'price': price, 'footprint': {'w': fw, 'h': fh}, 'cozy': cozy,
        'placement': {'indoor': True, 'walkable': False, 'wallMounted': False,
                      'blocksPath': True, 'unique': False},
        'asset': {'kind': 'svg', 'ref': 'assets/furniture/%s.svg' % id,
                  'size': {'w': g['w'], 'h': g['h']},
                  'anchor': {'ax': g['ax'], 'ay': g['ay']}},
        'ui': {'icon': id, 'desc': desc, 'order': 200 + len(items)},
    }
    if verb:
        it['interaction'] = {'verb': verb, 'durationSec': 2,
                             'effects': effects or {}, 'special': None}
    else:
        it['interaction'] = None
    items.append(it)

pack = {'schema': 'catalog/1', 'note': '室内家电/家具扩展包（24 件，落地式）', 'items': items}
out = os.path.join(ROOT, 'content', 'catalog', 'home.goods.json')
with open(out, 'w', encoding='utf-8') as f:
    json.dump(pack, f, ensure_ascii=False, indent=2)
print('catalog 写出 %d 件 → %s' % (len(items), out))

# ---- 注册进 manifest ----
mp = os.path.join(ROOT, 'content', 'manifest.json')
man = json.load(open(mp, encoding='utf-8'))
rel = 'catalog/home.goods.json'
if rel not in man['packs']:
    # 按字母顺序放在 items.decor 之后
    idx = man['packs'].index('catalog/items.decor.json') + 1
    man['packs'].insert(idx, rel)
man.setdefault('modules', {})[rel] = {
    'version': 1, 'hash': 'homegoods0001', 'updatedAt': '2026-11-06T00:00:00.000Z'}
with open(mp, 'w', encoding='utf-8') as f:
    json.dump(man, f, ensure_ascii=False, indent=2)
print('manifest 已注册', rel)
