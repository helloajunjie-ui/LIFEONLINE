# -*- coding: utf-8 -*-
"""生成 content/house/levels.json：5 个等级，地面分区（无实墙）。
布局原则（参考真实房产户型）：动静分区——下方进门是客厅/餐厅公共区，上方深处是卧室；
厨房紧邻餐厅，卫生间靠卧室区，大平层主卧套间化。"""
import json, os

ROOT = r'E:\QHTML'

# ---------- 地板配色（pattern + palette），加大功能区明度/冷暖差异 ----------
FLOOR = {
 'living':  {'pattern':'plank', 'palette':{'a':'#efe3c8','b':'#e4d4b4','line':'rgba(150,120,80,.14)','grout':'rgba(255,255,255,.20)'}},
 'dining':  {'pattern':'plank', 'palette':{'a':'#e3c896','b':'#d6b880','line':'rgba(140,105,60,.16)','grout':'rgba(255,250,230,.16)'}},
 'bed':     {'pattern':'plank', 'palette':{'a':'#d8b07e','b':'#c99e6a','line':'rgba(120,85,45,.20)','grout':'rgba(255,240,215,.14)'}},
 'study':   {'pattern':'plank', 'palette':{'a':'#b88a54','b':'#a87a46','line':'rgba(80,52,24,.26)','grout':'rgba(255,235,200,.14)'}},
 'wood':    {'pattern':'plank', 'palette':{'a':'#d9bd90','b':'#cab084','line':'rgba(130,105,70,.16)','grout':'rgba(255,245,225,.15)'}},
 'kitchen': {'pattern':'tile',  'palette':{'a':'#f4ede0','b':'#e6dcc8','line':'rgba(120,110,95,.20)','grout':'rgba(155,145,128,.30)'}},
 'bath':    {'pattern':'tile',  'palette':{'a':'#dde9f2','b':'#c8d8e6','line':'rgba(90,115,140,.24)','grout':'rgba(120,140,165,.34)'}},
 'mbath':   {'pattern':'tile',  'palette':{'a':'#d6e8e0','b':'#c2d8ce','line':'rgba(90,125,110,.24)','grout':'rgba(120,155,140,.32)'}},
}

def z(name, label, x, y, w, h, floor):
    return {'id': name, 'name': label,
            'rect': {'x':x,'y':y,'w':w,'h':h}, 'floor': FLOOR[floor]}

# ---------- 各等级分区（本地坐标，相对 footprint 左上角） ----------
LEVELS = []

# Lv0 温馨一居 14×10
LEVELS.append({'level':0,'id':'house.lv0','name':'温馨一居','price':0,'footprint':{'w':14,'h':10},'zones':[
    z('bedroom','卧室',0,0,14,4,'bed'),
    z('living','客厅',0,4,9,6,'living'),
    z('bath','卫生间',9,4,5,3,'bath'),
    z('kitchen','厨房',9,7,5,3,'kitchen'),
]})

# Lv1 两室一厅 17×12
LEVELS.append({'level':1,'id':'house.lv1','name':'两室一厅','price':2000,'footprint':{'w':17,'h':12},'zones':[
    z('master','主卧',0,0,9,5,'bed'),
    z('bed2','次卧',9,0,8,5,'bed'),
    z('living','客厅',0,5,8,7,'living'),
    z('dining','餐厅',8,5,4,7,'dining'),
    z('bath','卫生间',12,5,5,3,'bath'),
    z('kitchen','厨房',12,8,5,4,'kitchen'),
]})

# Lv2 三室两厅 20×14
LEVELS.append({'level':2,'id':'house.lv2','name':'三室两厅','price':6000,'footprint':{'w':20,'h':14},'zones':[
    z('master','主卧',0,0,9,6,'bed'),
    z('bed2','次卧',9,0,5,6,'bed'),
    z('bed3','次卧',14,0,6,6,'bed'),
    z('living','客厅',0,6,9,8,'living'),
    z('dining','餐厅',9,6,5,8,'dining'),
    z('bath','卫生间',14,6,6,4,'bath'),
    z('kitchen','厨房',14,10,6,4,'kitchen'),
]})

# Lv3 四室两厅双卫 23×16
LEVELS.append({'level':3,'id':'house.lv3','name':'四室两厅','price':15000,'footprint':{'w':23,'h':16},'zones':[
    z('master','主卧',0,0,8,7,'bed'),
    z('bed2','次卧',8,0,5,7,'bed'),
    z('bed3','次卧',13,0,5,7,'bed'),
    z('study','书房',18,0,5,7,'study'),
    z('living','客厅',0,7,9,9,'living'),
    z('dining','餐厅',9,7,5,9,'dining'),
    z('bath1','卫生间',14,7,4,5,'bath'),
    z('bath2','卫生间',18,7,5,5,'mbath'),
    z('kitchen','厨房',14,12,9,4,'kitchen'),
]})

# Lv4 大平层 27×18
LEVELS.append({'level':4,'id':'house.lv4','name':'大平层','price':32000,'footprint':{'w':27,'h':18},'zones':[
    z('master','主卧',0,0,10,7,'bed'),
    z('mbath','主卫',10,0,5,7,'mbath'),
    z('closet','衣帽间',15,0,4,7,'wood'),
    z('bed2','次卧',19,0,8,7,'bed'),
    z('bed3','次卧',0,7,8,5,'bed'),
    z('study','书房',8,7,7,5,'study'),
    z('guestbath','客卫',15,7,5,5,'bath'),
    z('kitchen','厨房',20,7,7,5,'kitchen'),
    z('living','客厅',0,12,13,6,'living'),
    z('dining','餐厅',13,12,7,6,'dining'),
    z('storage','储物间',20,12,7,6,'wood'),
]})

# ---------- 校验：不重叠、铺满、不越界 ----------
for lv in LEVELS:
    W, H = lv['footprint']['w'], lv['footprint']['h']
    covered = [[0]*W for _ in range(H)]
    area = 0
    for zn in lv['zones']:
        r = zn['rect']
        assert r['x']>=0 and r['y']>=0 and r['x']+r['w']<=W and r['y']+r['h']<=H, '越界 %s' % zn['id']
        for yy in range(r['y'], r['y']+r['h']):
            for xx in range(r['x'], r['x']+r['w']):
                assert covered[yy][xx] == 0, '重叠 %s @%d,%d' % (zn['id'], xx, yy)
                covered[yy][xx] = 1
                area += 1
    assert area == W*H, '%s 未铺满 %d/%d' % (lv['id'], area, W*H)
    print('Lv%d %s %d×%d 区%d 铺满OK' % (lv['level'], lv['name'], W, H, len(lv['zones'])))

out = {
 'schema':'house/1',
 'note':'房型等级：升级只扩大室内区块，左上角固定；地面分区（无实墙），每区内联地板配色，空间完全可走',
 'origin':{'x':3,'y':3},
 'yardMargin':3,
 'levels':[
   {**lv, 'walls':[],
    'door':{'edge':'bottom','offset':'center'}} for lv in LEVELS
 ]
}
p = os.path.join(ROOT,'content','house','levels.json')
with open(p,'w',encoding='utf-8',newline='') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print('写入', p)
