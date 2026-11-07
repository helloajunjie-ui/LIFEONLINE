#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
室内家电/家具批量生成器（24 件，全部落地/靠墙式，wallMounted=false）。

几何规则与 tools/gen-furniture.py 完全一致：
  Box(W, H) 顶面菱形宽 W（64 倍数）、侧面竖直高 H；
  锚点 (cx, ay) = 底面菱形中心，渲染时对齐占地中心地面点。
输出：
  assets/furniture/<id>.svg            独立源文件
  tools/home_goods_data.json           {id:{w,h,ax,ay,svg}}，供注入 HTML / 生成 catalog
"""
import json, os

ROOT = r'E:\QHTML'
ASSET_DIR = os.path.join(ROOT, 'assets', 'furniture')

# ---------- 颜色工具 ----------
def hx(c):
    c = c.lstrip('#')
    if len(c) == 3:
        c = ''.join(ch * 2 for ch in c)
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)

def tohex(t):
    return '#%02x%02x%02x' % tuple(max(0, min(255, round(v))) for v in t)

def mul(color, k):
    r, g, b = hx(color)
    return tohex((r * k, g * k, b * k))

EDGE = 'rgba(58,40,22,.32)'

# ---------- 几何 ----------
class Box:
    def __init__(self, W, H, top_y=12):
        self.W = W
        self.H = H
        self.ty = top_y
        self.half = W // 4
        self.cx = W // 2
        self.total_h = top_y + W // 2 + H + 9
        self.ay = top_y + self.half + H

    def top_pts(self):
        cx, ty, h = self.cx, self.ty, self.half
        return f'{cx},{ty} {cx + self.W // 2},{ty + h} {cx},{ty + h * 2} {cx - self.W // 2},{ty + h}'

    def right_face(self):
        cx, ty, h, W, H = self.cx, self.ty, self.half, self.W, self.H
        return f'{cx + W // 2},{ty + h} {cx},{ty + h * 2} {cx},{ty + h * 2 + H} {cx + W // 2},{ty + h + H}'

    def left_face(self):
        cx, ty, h, W, H = self.cx, self.ty, self.half, self.W, self.H
        return f'{cx - W // 2},{ty + h} {cx},{ty + h * 2} {cx},{ty + h * 2 + H} {cx - W // 2},{ty + h + H}'

    def r_point(self, u, d):
        cx, ty, h, W = self.cx, self.ty, self.half, self.W
        x0, y0 = cx + W // 2, ty + h
        x1, y1 = cx, ty + h * 2
        return (x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + d)

    def l_point(self, u, d):
        cx, ty, h, W = self.cx, self.ty, self.half, self.W
        x0, y0 = cx - W // 2, ty + h
        x1, y1 = cx, ty + h * 2
        return (x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + d)

    def r_quad(self, u0, u1, d0, d1):
        a = self.r_point(u0, d0); b = self.r_point(u1, d0)
        c = self.r_point(u1, d1); d = self.r_point(u0, d1)
        return f'{a[0]:.1f},{a[1]:.1f} {b[0]:.1f},{b[1]:.1f} {c[0]:.1f},{c[1]:.1f} {d[0]:.1f},{d[1]:.1f}'

    def l_quad(self, u0, u1, d0, d1):
        a = self.l_point(u0, d0); b = self.l_point(u1, d0)
        c = self.l_point(u1, d1); d = self.l_point(u0, d1)
        return f'{a[0]:.1f},{a[1]:.1f} {b[0]:.1f},{b[1]:.1f} {c[0]:.1f},{c[1]:.1f} {d[0]:.1f},{d[1]:.1f}'

    def t_point(self, u, v):
        cx, ty, h, W = self.cx, self.ty, self.half, self.W
        ox, oy = cx - W // 2, ty + h
        ax, ay = W // 2, -h
        bx, by = W // 2, h
        return (ox + ax * u + bx * v, oy + ay * u + by * v)

    def t_ellipse(self, u, v, rx, ry, extra=''):
        x, y = self.t_point(u, v)
        return f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{rx}" ry="{ry}" {extra}/>'

    def shadow(self):
        cx = self.cx
        y = self.ay + 3
        rx = self.W * 0.64
        ry = max(self.half * 1.05, rx * 0.42)
        return f'<ellipse cx="{cx}" cy="{y}" rx="{rx:.1f}" ry="{ry:.1f}" fill="rgba(58,40,22,.19)"/>'

    def body(self, top, right, left):
        return (
            f'<polygon points="{self.left_face()}" fill="{left}" stroke="{EDGE}" stroke-width="1"/>'
            f'<polygon points="{self.right_face()}" fill="{right}" stroke="{EDGE}" stroke-width="1"/>'
            f'<polygon points="{self.top_pts()}" fill="{top}" stroke="{EDGE}" stroke-width="1"/>'
        )

def svg(inner, w, h):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
            + inner + '</svg>')

def faces(base, b, kt=1.05, kr=0.88, kl=0.73):
    """统一明暗三面：顶亮、右中、左暗。"""
    return b.body(mul(base, kt), mul(base, kr), mul(base, kl))


# ============================ 电器 appliance ============================

def washer():
    # 洗衣机：白机身 + 正面圆形舱门 + 顶面控制钮
    b = Box(64, 44)
    base = '#eef0f2'
    parts = [b.shadow(), faces(base, b)]
    cx, cy = b.r_point(0.5, b.H * 0.56)
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="12.5" ry="12.5" fill="#d7dde1" stroke="{EDGE}"/>')
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="9" ry="9" fill="#7c8a96" stroke="#b9c2c8" stroke-width="1.4"/>')
    parts.append(f'<ellipse cx="{cx-2.5:.1f}" cy="{cy-3:.1f}" rx="3" ry="2.2" fill="rgba(255,255,255,.4)"/>')
    for (u, v) in ((0.3, 0.35), (0.5, 0.4), (0.7, 0.35)):
        x, y = b.t_point(u, v)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2" fill="#9aa3a8"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def microwave():
    # 微波炉：矮盒，正面深色窗 + 右侧窄控制区
    b = Box(64, 30)
    base = '#e4e7ea'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.08,0.68,5,b.H-5)}" fill="#3c4650" stroke="{EDGE}" stroke-width="0.8"/>')
    parts.append(f'<polygon points="{b.r_quad(0.12,0.64,8,b.H-9)}" fill="#697887" opacity=".55"/>')
    parts.append(f'<polygon points="{b.r_quad(0.74,0.94,5,b.H-5)}" fill="#c9cfd4" stroke="{EDGE}" stroke-width="0.8"/>')
    for k in range(3):
        x, y = b.r_point(0.84, 9 + k * 6)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.5" fill="#8a939a"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def oven():
    # 烤箱：2 格宽不锈钢，顶面灶眼 + 正面玻璃门
    b = Box(128, 40)
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="#45484c" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="#5c5f64" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="#94989c" stroke="{EDGE}"/>')
    for (u, v) in ((0.28, 0.32), (0.7, 0.32), (0.28, 0.7), (0.7, 0.7)):
        x, y = b.t_point(u, v)
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="9" ry="4.5" fill="#33363a" stroke="#6b6f73"/>')
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="4.5" ry="2.3" fill="#767a7e"/>')
    parts.append(f'<polygon points="{b.r_quad(0.08,0.92,7,b.H-6)}" fill="#3a3d41" stroke="{EDGE}" stroke-width="0.9"/>')
    parts.append(f'<polygon points="{b.r_quad(0.14,0.86,11,b.H-12)}" fill="rgba(120,150,170,.32)"/>')
    parts.append(f'<polygon points="{b.r_quad(0.3,0.7,3.5,6.5)}" fill="#b9bdc1"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def dishwasher():
    # 洗碗机：白盒，正面整门 + 顶部控制条 + 明显横向拉手
    b = Box(64, 40)
    base = '#eceff1'
    parts = [b.shadow(), faces(base, b)]
    # 门板
    parts.append(f'<polygon points="{b.r_quad(0.08,0.92,8,b.H-4)}" fill="#dde3e7" stroke="{EDGE}" stroke-width="0.9"/>')
    # 顶部控制条
    parts.append(f'<polygon points="{b.r_quad(0.08,0.92,3,7)}" fill="#c2c9ce" stroke="{EDGE}" stroke-width="0.7"/>')
    for k in range(3):
        x, y = b.r_point(0.32 + k * 0.18, 5)
        parts.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="1.3" fill="#7d868d"/>')
    # 横向长拉手
    parts.append(f'<polygon points="{b.r_quad(0.28,0.72,11,14)}" fill="#7d868d"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def coffee():
    # 咖啡机：深色机身，正面出水嘴 + 小杯
    b = Box(64, 34)
    base = '#3f444b'
    parts = [b.shadow(), faces(base, b, kt=1.08, kr=0.9, kl=0.72)]
    parts.append(f'<polygon points="{b.r_quad(0.2,0.8,3,8)}" fill="#2f343a"/>')
    nx, ny = b.r_point(0.5, 9)
    parts.append(f'<rect x="{nx-2:.1f}" y="{ny:.1f}" width="4" height="6" fill="#9aa3a8"/>')
    cx, cy = b.r_point(0.5, b.H - 7)
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy+3:.1f}" rx="6" ry="2.4" fill="#f2ede2"/>')
    parts.append(f'<rect x="{cx-5:.1f}" y="{cy-3:.1f}" width="10" height="6" rx="1.5" fill="#f7f2e8"/>')
    tx, ty = b.t_point(0.5, 0.4)
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty:.1f}" rx="5" ry="2.4" fill="#6b727a"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def waterdisp():
    # 饮水机：白机身 + 顶部倒置大水桶 + 正面两个出水嘴
    b = Box(64, 50)
    base = '#eef1f3'
    parts = [b.shadow(), faces(base, b)]
    tx, ty = b.t_point(0.5, 0.5)
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty-8:.1f}" rx="11" ry="10" fill="#9ec3dd" stroke="#7fa9c8" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{tx-3:.1f}" cy="{ty-11:.1f}" rx="3.4" ry="3" fill="rgba(255,255,255,.45)"/>')
    r1x, r1y = b.r_point(0.38, 12)
    r2x, r2y = b.r_point(0.62, 12)
    parts.append(f'<circle cx="{r1x:.1f}" cy="{r1y:.1f}" r="2.4" fill="#d96a5a"/>')
    parts.append(f'<circle cx="{r2x:.1f}" cy="{r2y:.1f}" r="2.4" fill="#5a86c8"/>')
    parts.append(f'<polygon points="{b.r_quad(0.25,0.75,16,20)}" fill="#d7dde2"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def ricecooker():
    # 电饭煲：圆润矮胖，椭圆顶盖 + 提手 + 正面按钮
    b = Box(64, 26)
    base = '#eef0f2'
    parts = [b.shadow(), faces(base, b)]
    # 前缘圆润：叠一个椭圆把硬角盖住
    rx, ry = b.r_point(0.5, b.H)
    parts.append(f'<ellipse cx="{rx:.1f}" cy="{ry:.1f}" rx="20" ry="6" fill="{mul(base,0.86)}"/>')
    # 顶盖
    tx, ty = b.t_point(0.5, 0.5)
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty:.1f}" rx="18" ry="8.5" fill="#f7f8f9" stroke="{EDGE}" stroke-width="0.9"/>')
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty-2:.1f}" rx="7" ry="2.6" fill="#d7dde1"/>')
    # 按钮
    bx, by = b.r_point(0.5, b.H - 6)
    parts.append(f'<ellipse cx="{bx:.1f}" cy="{by:.1f}" rx="4" ry="2" fill="#c85a4a"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def aircon():
    # 立式柜机：高瘦，顶部横向出风口 + 正面显示
    b = Box(64, 58)
    base = '#eef1f2'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.1,0.9,4,10)}" fill="#49525b" stroke="{EDGE}" stroke-width="0.8"/>')
    for k in range(3):
        parts.append(f'<polygon points="{b.r_quad(0.14,0.86,5.5+k*1.8,6.8+k*1.8)}" fill="#7d8893"/>')
    parts.append(f'<polygon points="{b.r_quad(0.3,0.7,18,26)}" fill="#d7dde1" stroke="{EDGE}" stroke-width="0.7"/>')
    d1x, d1y = b.r_point(0.5, 21)
    parts.append(f'<circle cx="{d1x:.1f}" cy="{d1y:.1f}" r="1.6" fill="#5aa0c8"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def robotvac():
    # 扫地机器人：扁平圆盘，顶面小凸起
    b = Box(64, 10)
    parts = [b.shadow()]
    cx, cy = b.t_point(0.5, 0.55)
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy+4:.1f}" rx="25" ry="11" fill="#3c424a" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="25" ry="11" fill="#565e68"/>')
    parts.append(f'<ellipse cx="{cx:.1f}" cy="{cy-1:.1f}" rx="16" ry="6.5" fill="#484f58"/>')
    parts.append(f'<circle cx="{cx:.1f}" cy="{cy-2:.1f}" r="3.4" fill="#7d8893"/>')
    parts.append(f'<ellipse cx="{cx-8:.1f}" cy="{cy-3:.1f}" rx="3" ry="1.4" fill="rgba(255,255,255,.28)"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def kettle():
    # 电热水壶：壶身 + 壶嘴（内收不出界）+ 弧形把手 + 盖
    b = Box(64, 28)
    base = '#cfd6db'
    parts = [b.shadow(), faces(base, b)]
    # 壶嘴（左后，锥形，x 不超出画布）
    sp = b.l_point(0.25, 5)
    parts.append(f'<polygon points="{sp[0]:.1f},{sp[1]:.1f} {sp[0]-6:.1f},{sp[1]-8:.1f} {sp[0]-2:.1f},{sp[1]+3:.1f}" fill="{mul(base,0.72)}" stroke="{EDGE}" stroke-width="0.8"/>')
    # 把手（右前，弧形）
    hp = b.r_point(0.9, 3)
    parts.append(f'<path d="M{hp[0]:.1f},{hp[1]:.1f} q12,2 10,16 q-1,6 -8,5" fill="none" stroke="#5c6369" stroke-width="2.6"/>')
    # 盖 + 钮
    tx, ty = b.t_point(0.5, 0.45)
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty:.1f}" rx="9" ry="4" fill="#aab2b8" stroke="{EDGE}" stroke-width="0.8"/>')
    parts.append(f'<circle cx="{tx:.1f}" cy="{ty-2:.1f}" r="2" fill="#5c6369"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def toaster():
    # 烤面包机：金属矮盒，顶面两个面包槽 + 侧面拨杆
    b = Box(64, 24)
    base = '#c8ccd0'
    parts = [b.shadow(), faces(base, b)]
    for (u, v) in ((0.32, 0.42), (0.66, 0.42)):
        x, y = b.t_point(u, v)
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="6" ry="2.6" fill="#3c4045"/>')
        # 露出的面包
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y-3:.1f}" rx="5" ry="3" fill="#e0b878" stroke="#c89a5a" stroke-width="0.8"/>')
    lx, ly = b.r_point(0.85, b.H * 0.5)
    parts.append(f'<rect x="{lx-1.2:.1f}" y="{ly-5:.1f}" width="2.4" height="8" rx="1" fill="#6b7278"/>')
    return svg(''.join(parts), b.W, b.total_h), b


# ============================ 家具 furniture ============================

def desk():
    # 书桌：薄桌面 + 4 腿 + 右侧抽屉
    b = Box(128, 12)
    base = '#b98a52'
    leg_h = 26
    parts = [b.shadow()]
    for (uu, side) in ((0.1, 'r'), (0.9, 'r'), (0.1, 'l'), (0.9, 'l')):
        p0 = b.r_point(uu, b.H) if side == 'r' else b.l_point(uu, b.H)
        parts.append(f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p0[0]:.1f}" y2="{p0[1]+leg_h:.1f}" stroke="{mul(base,0.55)}" stroke-width="3.4" stroke-linecap="round"/>')
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(base,0.74)}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(base,0.9)}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(base,1.08)}" stroke="{EDGE}"/>')
    # 右抽屉
    parts.append(f'<polygon points="{b.r_quad(0.55,0.9,2,9)}" fill="{mul(base,0.82)}" stroke="{EDGE}" stroke-width="0.7"/>')
    hx1, hy1 = b.r_point(0.72, 5.5)
    parts.append(f'<circle cx="{hx1:.1f}" cy="{hy1:.1f}" r="1.5" fill="#5d4420"/>')
    b.ay += leg_h
    b.total_h += leg_h
    return svg(''.join(parts), b.W, b.total_h), b

def chair():
    # 办公椅：座面 + 靠背 + 4 腿
    b = Box(64, 14, top_y=30)
    base = '#7d8fa3'
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(base,0.74)}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(base,0.9)}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(base,1.06)}" stroke="{EDGE}"/>')
    # 靠背
    bl = b.t_point(0.08, 0.08); br = b.t_point(0.92, 0.08)
    hb = 22
    parts.append(f'<polygon points="{bl[0]:.1f},{bl[1]-hb:.1f} {br[0]:.1f},{br[1]-hb:.1f} {br[0]:.1f},{br[1]:.1f} {bl[0]:.1f},{bl[1]:.1f}" fill="{mul(base,0.92)}" stroke="{EDGE}"/>')
    # 腿
    for (uu, side) in ((0.18, 'r'), (0.82, 'r'), (0.18, 'l'), (0.82, 'l')):
        p0 = b.r_point(uu, b.H) if side == 'r' else b.l_point(uu, b.H)
        parts.append(f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p0[0]:.1f}" y2="{p0[1]+16:.1f}" stroke="#5d6670" stroke-width="2.6" stroke-linecap="round"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def coffeetable():
    # 茶几：矮桌面 + 下层隔板 + 短腿
    b = Box(128, 10)
    base = '#b08a58'
    leg_h = 16
    parts = [b.shadow()]
    for (uu, side) in ((0.12, 'r'), (0.88, 'r'), (0.12, 'l'), (0.88, 'l')):
        p0 = b.r_point(uu, b.H) if side == 'r' else b.l_point(uu, b.H)
        parts.append(f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p0[0]:.1f}" y2="{p0[1]+leg_h:.1f}" stroke="{mul(base,0.55)}" stroke-width="3" stroke-linecap="round"/>')
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(base,0.74)}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(base,0.9)}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(base,1.08)}" stroke="{EDGE}"/>')
    # 下层隔板
    sx1, sy1 = b.r_point(0.14, b.H + leg_h * 0.55)
    sx2, sy2 = b.r_point(0.86, b.H + leg_h * 0.55)
    parts.append(f'<polygon points="{b.r_quad(0.14,0.86,b.H+leg_h*0.5,b.H+leg_h*0.55+3)}" fill="{mul(base,0.8)}" stroke="{EDGE}" stroke-width="0.7"/>')
    b.ay += leg_h
    b.total_h += leg_h
    return svg(''.join(parts), b.W, b.total_h), b

def tvstand():
    # 电视柜：2 格矮柜，开放格 + 柜门
    b = Box(128, 22)
    base = '#a98a60'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.06,0.46,4,b.H-4)}" fill="{mul(base,0.62)}" stroke="{EDGE}" stroke-width="0.8"/>')
    parts.append(f'<polygon points="{b.r_quad(0.54,0.94,4,b.H-4)}" fill="{mul(base,0.85)}" stroke="{EDGE}" stroke-width="0.8"/>')
    hx1, hy1 = b.r_point(0.74, b.H * 0.5)
    parts.append(f'<circle cx="{hx1:.1f}" cy="{hy1:.1f}" r="1.5" fill="#5d4420"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def nightstand():
    # 床头柜：小柜，上下两个抽屉
    b = Box(64, 28)
    base = '#b98f62'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.1,0.9,3,13)}" fill="{mul(base,0.85)}" stroke="{EDGE}" stroke-width="0.8"/>')
    parts.append(f'<polygon points="{b.r_quad(0.1,0.9,15,b.H-3)}" fill="{mul(base,0.8)}" stroke="{EDGE}" stroke-width="0.8"/>')
    for yy in (8, 20):
        hx1, hy1 = b.r_point(0.5, yy)
        parts.append(f'<circle cx="{hx1:.1f}" cy="{hy1:.1f}" r="1.5" fill="#5d4420"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def vanity():
    # 梳妆台：台面柜 + 竖起的镜子
    b = Box(128, 26)
    base = '#c89a78'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.1,0.9,4,b.H-3)}" fill="{mul(base,0.85)}" stroke="{EDGE}" stroke-width="0.8"/>')
    # 镜子：沿后边竖起
    ml = b.t_point(0.18, 0.04); mr = b.t_point(0.82, 0.04)
    mh = 34
    parts.append(f'<polygon points="{ml[0]:.1f},{ml[1]-mh:.1f} {mr[0]:.1f},{mr[1]-mh:.1f} {mr[0]:.1f},{mr[1]:.1f} {ml[0]:.1f},{ml[1]:.1f}" fill="#cfe0ea" stroke="#8a6a4a" stroke-width="1.6"/>')
    parts.append(f'<polygon points="{ml[0]+4:.1f},{ml[1]-mh+4:.1f} {ml[0]+10:.1f},{ml[1]-mh+4:.1f} {ml[0]+6:.1f},{ml[1]-10:.1f}" fill="rgba(255,255,255,.5)"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def shower():
    # 淋浴间：底盘 + 两面半透明玻璃 + 喷头（top_y 下移保证玻璃在画布内）
    b = Box(128, 12, top_y=30)
    gh = 42
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="#c9d2d8" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="#d6dde2" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="#e7ecef" stroke="{EDGE}"/>')
    # 后玻璃
    bl = b.t_point(0.02, 0.0); br = b.t_point(0.98, 0.0)
    parts.append(f'<polygon points="{bl[0]:.1f},{bl[1]-gh:.1f} {br[0]:.1f},{br[1]-gh:.1f} {br[0]:.1f},{br[1]:.1f} {bl[0]:.1f},{bl[1]:.1f}" fill="rgba(150,195,225,.4)" stroke="rgba(110,150,180,.65)" stroke-width="1"/>')
    # 左玻璃
    lf = b.t_point(0.0, 0.98)
    parts.append(f'<polygon points="{bl[0]:.1f},{bl[1]-gh:.1f} {lf[0]:.1f},{lf[1]-gh:.1f} {lf[0]:.1f},{lf[1]:.1f} {bl[0]:.1f},{bl[1]:.1f}" fill="rgba(150,195,225,.32)" stroke="rgba(110,150,180,.55)" stroke-width="1"/>')
    # 喷头 + 竖杆
    hx2 = bl[0] + 6
    parts.append(f'<line x1="{hx2:.1f}" y1="{bl[1]-gh:.1f}" x2="{hx2:.1f}" y2="{bl[1]-gh+12:.1f}" stroke="#8a939a" stroke-width="2.4"/>')
    parts.append(f'<circle cx="{hx2:.1f}" cy="{bl[1]-gh:.1f}" r="3.4" fill="#6b7278"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def washbasin():
    # 洗手台：立柱 + 椭圆盆 + 龙头
    b = Box(64, 38)
    base = '#eceff1'
    parts = [b.shadow(), faces(base, b)]
    # 立柱收窄（左面一条深色表示立柱）
    parts.append(f'<polygon points="{b.l_quad(0.35,0.65,12,b.H-2)}" fill="{mul(base,0.68)}"/>')
    # 盆
    tx, ty = b.t_point(0.5, 0.55)
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty:.1f}" rx="16" ry="8" fill="#cdd6da" stroke="{EDGE}" stroke-width="0.9"/>')
    parts.append(f'<ellipse cx="{tx:.1f}" cy="{ty:.1f}" rx="12" ry="5.6" fill="#aab8bf"/>')
    # 龙头
    fx2, fy2 = b.t_point(0.5, 0.16)
    parts.append(f'<rect x="{fx2-1.8:.1f}" y="{fy2-12:.1f}" width="3.6" height="13" fill="#9aa6b0"/>')
    parts.append(f'<rect x="{fx2-2:.1f}" y="{fy2-14:.1f}" width="10" height="3.4" fill="#9aa6b0"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def shoecab():
    # 鞋柜：高瘦，百叶门多条横线
    b = Box(64, 42)
    base = '#c09a6a'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.08,0.92,4,b.H-4)}" fill="{mul(base,0.85)}" stroke="{EDGE}" stroke-width="0.8"/>')
    for k in range(6):
        d = 7 + k * 5.4
        parts.append(f'<polygon points="{b.r_quad(0.14,0.86,d,d+1.8)}" fill="{mul(base,0.55)}"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def kitcab():
    # 橱柜：高柜门 + 把手
    b = Box(64, 56)
    base = '#cdb48c'
    parts = [b.shadow(), faces(base, b)]
    parts.append(f'<polygon points="{b.r_quad(0.08,0.92,5,b.H-5)}" fill="{mul(base,0.9)}" stroke="{EDGE}" stroke-width="0.9"/>')
    parts.append(f'<polygon points="{b.r_quad(0.47,0.53,8,b.H-8)}" fill="{mul(base,0.6)}"/>')
    hx2, hy2 = b.r_point(0.3, b.H * 0.5)
    parts.append(f'<circle cx="{hx2:.1f}" cy="{hy2:.1f}" r="1.8" fill="#5d4420"/>')
    return svg(''.join(parts), b.W, b.total_h), b


# ============================ 装饰 decor ============================

def mirror():
    # 落地穿衣镜：底座 + 木框 + 镜面高光
    b = Box(64, 8, top_y=44)
    base = '#a98a5f'
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(base,1.0)}" stroke="{EDGE}"/>')
    ml = b.t_point(0.12, 0.05); mr = b.t_point(0.88, 0.05)
    mh = 46
    parts.append(f'<polygon points="{ml[0]:.1f},{ml[1]-mh:.1f} {mr[0]:.1f},{mr[1]-mh:.1f} {mr[0]:.1f},{mr[1]:.1f} {ml[0]:.1f},{ml[1]:.1f}" fill="{base}" stroke="{EDGE}"/>')
    parts.append(f'<polygon points="{ml[0]+3:.1f},{ml[1]-mh+4:.1f} {mr[0]-3:.1f},{mr[1]-mh+4:.1f} {mr[0]-3:.1f},{mr[1]-4:.1f} {ml[0]+3:.1f},{ml[1]-4:.1f}" fill="#cfe0ec"/>')
    parts.append(f'<polygon points="{ml[0]+5:.1f},{ml[1]-mh+7:.1f} {ml[0]+11:.1f},{ml[1]-mh+7:.1f} {ml[0]+7:.1f},{mr[1]-9:.1f}" fill="rgba(255,255,255,.55)"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def floorlamp():
    # 落地灯：圆盘底座 + 长杆 + 灯罩（top_y 下移，保证灯罩在画布内）
    b = Box(64, 8, top_y=62)
    base = '#8a7f6e'
    parts = [b.shadow()]
    bx, by = b.t_point(0.5, 0.5)
    parts.append(f'<ellipse cx="{bx:.1f}" cy="{by+2:.1f}" rx="14" ry="6.5" fill="{mul(base,0.8)}" stroke="{EDGE}"/>')
    pole_h = 52
    parts.append(f'<rect x="{bx-1.6:.1f}" y="{by-pole_h:.1f}" width="3.2" height="{pole_h}" fill="#9a8d78"/>')
    top_y = by - pole_h
    parts.append(f'<polygon points="{bx-10:.1f},{top_y-18:.1f} {bx+10:.1f},{top_y-18:.1f} {bx+17:.1f},{top_y+2:.1f} {bx-17:.1f},{top_y+2:.1f}" fill="#e8d3a8" stroke="rgba(120,100,70,.45)"/>')
    parts.append(f'<ellipse cx="{bx:.1f}" cy="{top_y+2:.1f}" rx="9" ry="3" fill="rgba(255,226,150,.8)"/>')
    return svg(''.join(parts), b.W, b.total_h), b

def gfclock():
    # 落地座钟：高柜 + 钟面指针 + 钟摆
    b = Box(64, 58)
    base = '#8a6a48'
    parts = [b.shadow(), faces(base, b)]
    cx, cy = b.r_point(0.5, 14)
    parts.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="10" fill="#f2ede2" stroke="#5d4420" stroke-width="1.4"/>')
    parts.append(f'<line x1="{cx:.1f}" y1="{cy:.1f}" x2="{cx:.1f}" y2="{cy-6:.1f}" stroke="#3a2a18" stroke-width="1.2"/>')
    parts.append(f'<line x1="{cx:.1f}" y1="{cy:.1f}" x2="{cx+5:.1f}" y2="{cy+2:.1f}" stroke="#3a2a18" stroke-width="1.2"/>')
    parts.append(f'<polygon points="{b.r_quad(0.35,0.65,26,42)}" fill="{mul(base,0.55)}"/>')
    px, py = b.r_point(0.5, 44)
    parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="3" fill="#d9b878"/>')
    return svg(''.join(parts), b.W, b.total_h), b


# ============================ 注册表 ============================
ITEMS = {
    # 电器
    'washer': washer, 'microwave': microwave, 'oven': oven, 'dishwasher': dishwasher,
    'coffee': coffee, 'waterdisp': waterdisp, 'ricecooker': ricecooker, 'aircon': aircon,
    'robotvac': robotvac, 'kettle': kettle, 'toaster': toaster,
    # 家具
    'desk': desk, 'chair': chair, 'coffeetable': coffeetable, 'tvstand': tvstand,
    'nightstand': nightstand, 'vanity': vanity, 'shower': shower, 'washbasin': washbasin,
    'shoecab': shoecab, 'kitcab': kitcab,
    # 装饰
    'mirror': mirror, 'floorlamp': floorlamp, 'gfclock': gfclock,
}

def main():
    os.makedirs(ASSET_DIR, exist_ok=True)
    data = {}
    for name, fn in ITEMS.items():
        s, b = fn()
        with open(os.path.join(ASSET_DIR, name + '.svg'), 'w', encoding='utf-8', newline='') as f:
            f.write(s)
        data[name] = {'w': b.W, 'h': b.total_h, 'ax': b.cx, 'ay': b.ay, 'svg': s}
        print('%-11s %3dx%-3d ax=%-2d ay=%-2d %5dB' % (name, b.W, b.total_h, b.cx, b.ay, len(s)))
    out = os.path.join(ROOT, 'tools', 'home_goods_data.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False)
    print('共 %d 件 → %s' % (len(data), out))

if __name__ == '__main__':
    main()





