#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
等距家具 SVG 生成器。

为什么要有生成器：手画 19 个 SVG 时，每件的"侧面高度"都是凭感觉给的，
结果矮家具（桌、灶台、冰箱）的侧面被压掉一半，在等距视角里看起来就是
"一大块斜顶面 + 一条矮边"——玩家会读成"家具倒在地上"。

这里把所有家具放进同一套几何规则里：
  顶面菱形宽 W、高 W/2；侧面竖直高度 H 按真实家具比例给；
  光源固定在左上前方 → 顶面 1.00 / 右面 0.86 / 左面 0.72；
  所有可见面统一描边 rgba(58,40,22,.32)，底部加椭圆投影。

输出直接是 `FURN_SVG` 里的 svg 字符串，坐标原点在图片左上角。
"""

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

def mix(a, b, t):
    r1, g1, b1 = hx(a); r2, g2, b2 = hx(b)
    return tohex((r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t))

EDGE = 'rgba(58,40,22,.32)'

# ---------- 几何 ----------
class Box:
    """等距盒子。W 是顶面菱形宽（64 的倍数），H 是侧面竖直高度。"""
    def __init__(self, W, H, top_y=12):
        self.W = W
        self.H = H
        self.ty = top_y
        self.half = W // 4          # 菱形半高
        self.cx = W // 2            # 中心 x
        self.total_h = top_y + W // 2 + H + 9   # 图片总高（含投影余量）
        self.ay = top_y + self.half + H          # 锚点：底面菱形中心

    # 顶面四角（前 / 右 / 后 / 左）
    def top_pts(self):
        cx, ty, h = self.cx, self.ty, self.half
        return f'{cx},{ty} {cx + self.W // 2},{ty + h} {cx},{ty + h * 2} {cx - self.W // 2},{ty + h}'

    def right_face(self):
        cx, ty, h, W, H = self.cx, self.ty, self.half, self.W, self.H
        return f'{cx + W // 2},{ty + h} {cx},{ty + h * 2} {cx},{ty + h * 2 + H} {cx + W // 2},{ty + h + H}'

    def left_face(self):
        cx, ty, h, W, H = self.cx, self.ty, self.half, self.W, self.H
        return f'{cx - W // 2},{ty + h} {cx},{ty + h * 2} {cx},{ty + h * 2 + H} {cx - W // 2},{ty + h + H}'

    # 右面上的一点：u 沿上边（0=右后角, 1=前角），d 是竖直向下的距离
    def r_point(self, u, d):
        cx, ty, h, W = self.cx, self.ty, self.half, self.W
        x0, y0 = cx + W // 2, ty + h
        x1, y1 = cx, ty + h * 2
        return (x0 + (x1 - x0) * u, y0 + (y1 - y0) * u + d)

    # 左面上的一点
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

    # 顶面上的一点：(u 沿"左后→右后"边, v 沿"左后→左前"边)
    def t_point(self, u, v):
        cx, ty, h, W = self.cx, self.ty, self.half, self.W
        # 左后角 (cx - W/2, ty + h) 为原点，两个基向量
        ox, oy = cx - W // 2, ty + h
        ax, ay = W // 2, -h        # 到后角
        bx, by = W // 2, h         # 到前角
        return (ox + ax * u + bx * v, oy + ay * u + by * v)

    def t_ellipse(self, u, v, rx, ry, extra=''):
        x, y = self.t_point(u, v)
        # 等距压缩：竖向半径减半，贴近菱形透视
        return f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="{rx}" ry="{ry}" {extra}/>'

    def shadow(self):
        # 阴影必须落在「底面菱形中心」（= ay），等距视角里那一点才是脚踩的地面。
        # 之前放在底面最低点（前角）再往下 2px，等于把影子画进了地底，
        # 家具看起来就浮在影子上面——"飘"就是这么来的。
        # 半径要比底面菱形大一圈：等大或更小的话会被柜体完全盖住，
        # 柜子就"没有影子的贴纸"，反而更像浮着。
        cx = self.cx
        y = self.ay + 3
        rx = self.W * 0.64
        # 竖向半径也要略大于底面菱形半高（W/4），否则上下露不出来，
        # 只剩左右两条月牙，看起来像"柜子贴着两块暗斑"
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


# ---------- 各件家具 ----------
def wardrobe():
    b = Box(64, 64)
    base = '#c8974f'
    top, right, left = mul(base, 1.06), mul(base, 0.9), mul(base, 0.74)
    parts = [b.shadow(), b.body(top, right, left)]
    # 右侧双门：沿右面斜边切两块，中间留缝
    door = mul(base, 0.97)
    for (u0, u1) in ((0.06, 0.47), (0.53, 0.94)):
        parts.append(f'<polygon points="{b.r_quad(u0, u1, 9, b.H - 6)}" fill="{door}" '
                     f'stroke="rgba(58,40,22,.28)" stroke-width="1"/>')
        # 把手：靠中缝一侧
        uu = u1 - 0.09 if u0 < 0.5 else u0 + 0.09
        px, py = b.r_point(uu, b.H * 0.52)
        parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="1.7" fill="#5d4420"/>')
    # 左侧一条淡淡的接缝，避免大片空白；不要整片竖条纹（会像百叶板）
    parts.append(f'<polygon points="{b.l_quad(0.46, 0.52, 7, b.H - 6)}" fill="{mul(base, 0.7)}" opacity=".55"/>')
    # 顶面高光边
    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" stroke="rgba(255,246,224,.5)" stroke-width="1.4"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def bookshelf():
    b = Box(64, 58)
    base = '#b98a4e'
    top, right, left = mul(base, 1.08), mul(base, 0.9), mul(base, 0.73)
    parts = [b.shadow(), b.body(top, right, left)]
    books = ['#a8503f', '#3f6a8e', '#4d8459', '#b08a45', '#6f568f', '#a56a38']
    # 右面四层书架：每层一块深色隔板 + 一排书脊
    for row in range(4):
        d0 = 5 + row * (b.H - 12) / 4
        d1 = d0 + 2.2
        parts.append(f'<polygon points="{b.r_quad(0.04, 0.96, d0, d1)}" fill="{mul(base, 0.55)}"/>')
        # 书：从 d1 往上立（即 d 更小），宽度均分
        n = 6
        for k in range(n):
            u0 = 0.05 + k * 0.15
            u1 = u0 + 0.115
            hgt = 9 + ((k * 7 + row * 3) % 5)
            dd = max(d0 - 6, d0 - hgt)
            parts.append(f'<polygon points="{b.r_quad(u0, u1, dd, d1 - 0.6)}" '
                         f'fill="{books[(k + row) % len(books)]}" opacity=".92"/>')
    # 左面木纹
    for k in range(3):
        u = 0.2 + k * 0.25
        parts.append(f'<polyline points="{b.l_point(u, 5)[0]:.1f},{b.l_point(u, 5)[1]:.1f} '
                     f'{b.l_point(u, b.H - 6)[0]:.1f},{b.l_point(u, b.H - 6)[1]:.1f}" '
                     f'stroke="rgba(58,40,22,.14)" stroke-width="1"/>')
    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" stroke="rgba(255,246,224,.45)" stroke-width="1.4"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def fridge():
    b = Box(64, 56)
    base = '#eef1f2'
    top, right, left = mul(base, 1.0), mul(base, 0.88), mul(base, 0.74)
    parts = [b.shadow(), b.body(top, right, left)]
    # 冷冻室门缝（上 1/3）
    parts.append(f'<polygon points="{b.r_quad(0.04, 0.96, 3, 5)}" fill="#c3c9cc" stroke="{EDGE}" stroke-width="0.8"/>')
    parts.append(f'<polygon points="{b.r_quad(0.04, 0.96, 19, 21)}" fill="#c3c9cc" stroke="{EDGE}" stroke-width="0.8"/>')
    # 两段把手
    for d0, d1 in ((7, 15), (24, 34)):
        parts.append(f'<polygon points="{b.r_quad(0.1, 0.16, d0, d1)}" fill="#9aa3a8" stroke="{EDGE}" stroke-width="0.6"/>')
    # 顶面一点点暖光
    parts.append(b.t_ellipse(0.3, 0.28, 6, 2.6, 'fill="rgba(255,255,255,.30)"'))
    return svg(''.join(parts), b.W, b.total_h), b


def stove():
    # 不锈钢灶台：顶面偏亮、侧面偏深，靠明暗差把"厚度"读出来
    b = Box(128, 46)
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="#4e5155" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="#65686c" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="#9a9ea2" stroke="{EDGE}" stroke-width="1"/>')
    # 顶面四个灶眼
    for (u, v) in ((0.26, 0.28), (0.68, 0.28), (0.26, 0.72), (0.68, 0.72)):
        x, y = b.t_point(u, v)
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="10" ry="5" fill="#3a3c3f" stroke="rgba(20,18,16,.55)" stroke-width="1"/>')
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="5.4" ry="2.7" fill="#6b6e72"/>')
        parts.append(f'<ellipse cx="{x:.1f}" cy="{y:.1f}" rx="2" ry="1" fill="#a8acb0"/>')
    # 右面：烤箱门 + 玻璃窗 + 拉手
    parts.append(f'<polygon points="{b.r_quad(0.05, 0.95, 6, b.H - 6)}" fill="#5b5e62" stroke="rgba(20,18,16,.45)" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.r_quad(0.1, 0.9, 11, b.H - 14)}" fill="rgba(32,35,38,.9)"/>')
    parts.append(f'<polygon points="{b.r_quad(0.13, 0.87, 13, b.H - 18)}" fill="rgba(122,152,172,.28)"/>')
    parts.append(f'<polygon points="{b.r_quad(0.14, 0.86, 3, 6)}" fill="#b9bdc1" stroke="rgba(20,18,16,.4)" stroke-width="0.8"/>')
    # 左面散热格栅
    for k in range(4):
        d = 8 + k * 8
        parts.append(f'<polygon points="{b.l_quad(0.12, 0.88, d, d + 2.4)}" fill="#3f4245" opacity=".7"/>')
    p2 = b.top_pts().split()
    parts.append(f'<polyline points="{p2[3]} {p2[0]} {p2[1]}" fill="none" stroke="rgba(255,255,255,.55)" stroke-width="1.6"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def dining():
    # 桌面只占 9px 厚，剩下的是桌腿——之前把桌腿算进了"盒子高度"，
    # 结果桌面成了一块 40px 厚的板，腿只露出 10px，看起来像飘着。
    b = Box(128, 9)
    base = '#c08b4a'
    top, right, left = mul(base, 1.1), mul(base, 0.9), mul(base, 0.74)
    leg_h = 34
    leg = mul(base, 0.56)
    parts = [b.shadow()]
    desk_bottom = b.ty + b.W // 2 + b.H      # 桌面底面（前角）y
    # 四条腿：从桌面内侧往下垂，先画（不遮桌面）
    for (uu, side) in ((0.14, 'r'), (0.86, 'r'), (0.14, 'l'), (0.86, 'l')):
        p0 = b.r_point(uu, b.H - 1) if side == 'r' else b.l_point(uu, b.H - 1)
        parts.append(f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p0[0]:.1f}" y2="{p0[1] + leg_h:.1f}" '
                     f'stroke="{leg}" stroke-width="3.6" stroke-linecap="round"/>')
    # 桌面
    parts.append(f'<polygon points="{b.left_face()}" fill="{left}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{right}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{top}" stroke="{EDGE}" stroke-width="1"/>')
    # 木纹 + 两只盘子 + 一只杯子
    for k in range(3):
        u = 0.18 + k * 0.28
        a = b.t_point(u, 0.06); c2 = b.t_point(u, 0.94)
        parts.append(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{c2[0]:.1f}" y2="{c2[1]:.1f}" '
                     f'stroke="rgba(120,80,32,.16)" stroke-width="1"/>')
    for (u, v) in ((0.3, 0.42), (0.7, 0.62)):
        parts.append(b.t_ellipse(u, v, 11, 5.2, 'fill="#f7f4ec" stroke="rgba(140,130,110,.5)" stroke-width="1"'))
        parts.append(b.t_ellipse(u, v, 7, 3.3, 'fill="#ffffff"'))
    cx2, cy2 = b.t_point(0.5, 0.5)
    parts.append(f'<ellipse cx="{cx2:.1f}" cy="{cy2 - 3:.1f}" rx="4" ry="2" fill="#8a6bb5"/>')
    parts.append(f'<rect x="{cx2 - 4:.1f}" y="{cy2 - 3:.1f}" width="8" height="4" fill="#7d5fa8"/>')
    p2 = b.top_pts().split()
    parts.append(f'<polyline points="{p2[3]} {p2[0]} {p2[1]}" fill="none" stroke="rgba(255,246,224,.5)" stroke-width="1.4"/>')
    # 锚点要落在腿底而不是桌面底——否则桌子会连着桌腿一起插进地板
    b.ay += leg_h
    b.total_h += leg_h
    return svg(''.join(parts), b.W, b.total_h), b


def shelf():
    b = Box(64, 42)
    base = '#c9974f'
    top, right, left = mul(base, 1.08), mul(base, 0.9), mul(base, 0.73)
    parts = [b.shadow(), b.body(top, right, left)]
    # 三层开放格 + 摆件
    for row in range(3):
        d0 = 4 + row * (b.H - 8) / 3
        parts.append(f'<polygon points="{b.r_quad(0.04, 0.96, d0, d0 + 2)}" fill="{mul(base, 0.55)}"/>')
    # 摆件：书 / 相框 / 小盆栽
    parts.append(f'<polygon points="{b.r_quad(0.1, 0.2, 4, 15)}" fill="#c8584a"/>')
    parts.append(f'<polygon points="{b.r_quad(0.22, 0.31, 6, 15)}" fill="#4a7fb5"/>')
    px, py = b.r_point(0.62, 9)
    parts.append(f'<rect x="{px - 5:.1f}" y="{py - 8:.1f}" width="10" height="8" fill="#8a6bb5" '
                 f'stroke="{EDGE}" stroke-width="0.8"/>')
    px, py = b.r_point(0.42, b.H - 6)
    parts.append(f'<circle cx="{px:.1f}" cy="{py - 3:.1f}" r="4" fill="#5da36a"/>')
    parts.append(f'<polygon points="{b.r_quad(0.36, 0.48, b.H - 8, b.H - 3)}" fill="#b9743f"/>')
    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" stroke="rgba(255,246,224,.45)" stroke-width="1.4"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def bed():
    b = Box(128, 22)
    frame = '#b07f3f'
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(frame,0.72)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(frame,0.9)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(frame,1.02)}" stroke="{EDGE}" stroke-width="1"/>')

    def quad(u0, v0, u1, v1):
        p0 = b.t_point(u0, v0); p1 = b.t_point(u1, v0)
        p2 = b.t_point(u1, v1); p3 = b.t_point(u0, v1)
        return '%.1f,%.1f %.1f,%.1f %.1f,%.1f %.1f,%.1f' % (p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])

    # 床垫：整块内缩
    parts.append(f'<polygon points="{quad(0.05,0.05,0.95,0.95)}" fill="#f6f1e4" stroke="rgba(150,135,110,.55)" stroke-width="1"/>')
    # 被子：靠后那一段（v 小的一侧），刚好盖住床垫，不外溢
    parts.append(f'<polygon points="{quad(0.05,0.05,0.95,0.52)}" fill="#7ea8c9" stroke="rgba(60,90,120,.4)" stroke-width="1"/>')
    # 被角折线，让被子有厚度
    a = b.t_point(0.05, 0.52); c = b.t_point(0.95, 0.52)
    parts.append(f'<polyline points="{a[0]:.1f},{a[1]:.1f} {(a[0]+c[0])/2:.1f},{(a[1]+c[1])/2+4:.1f} {c[0]:.1f},{c[1]:.1f}" '
                 f'fill="none" stroke="rgba(60,90,120,.45)" stroke-width="1.4"/>')
    # 枕头两只，靠前那一段
    for u in (0.28, 0.72):
        px, py = b.t_point(u, 0.78)
        parts.append(f'<ellipse cx="{px:.1f}" cy="{py:.1f}" rx="14" ry="6.4" fill="#ffffff" stroke="#e2dac8" stroke-width="1"/>')
        parts.append(f'<ellipse cx="{px:.1f}" cy="{py-1:.1f}" rx="10" ry="4" fill="#fbf8f0"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def sofa():
    # 沙发拆成「座体」和「靠背矮墙」两块：靠背单独画在座面之上，
    # 否则会被座面盖住，看起来就只是一张矮桌。
    b = Box(128, 24, top_y=46)
    cloth = '#6e97bd'
    hb = 26
    parts = [b.shadow()]
    # 座体
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(cloth,0.74)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(cloth,0.9)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(cloth,1.04)}" stroke="{EDGE}" stroke-width="1"/>')

    def quad(u0, v0, u1, v1):
        p0 = b.t_point(u0, v0); p1 = b.t_point(u1, v0)
        p2 = b.t_point(u1, v1); p3 = b.t_point(u0, v1)
        return '%.1f,%.1f %.1f,%.1f %.1f,%.1f %.1f,%.1f' % (p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])

    # 坐垫：两块，沿座面中线分开
    for u0, u1 in ((0.06, 0.48), (0.52, 0.94)):
        parts.append(f'<polygon points="{quad(u0,0.5,u1,0.94)}" fill="{mul(cloth,1.1)}" '
                     f'stroke="rgba(40,60,85,.3)" stroke-width="1"/>')

    # 靠背：沿后边（v=0.06）整条竖起的一块，画在座面之后
    back_l = b.t_point(0.04, 0.06)
    back_r = b.t_point(0.96, 0.06)
    # 靠背正面（朝观察者）
    parts.append(f'<polygon points="{back_l[0]:.1f},{back_l[1]-hb:.1f} {back_r[0]:.1f},{back_r[1]-hb:.1f} '
                 f'{back_r[0]:.1f},{back_r[1]:.1f} {back_l[0]:.1f},{back_l[1]:.1f}" '
                 f'fill="{mul(cloth,0.92)}" stroke="{EDGE}" stroke-width="1"/>')
    # 靠背顶面：一条沿等距方向的窄条，做出厚度
    parts.append(f'<polygon points="{back_l[0]:.1f},{back_l[1]-hb:.1f} {back_r[0]:.1f},{back_r[1]-hb:.1f} '
                 f'{back_r[0]-6:.1f},{back_r[1]-hb-7:.1f} {back_l[0]-6:.1f},{back_l[1]-hb-7:.1f}" '
                 f'fill="{mul(cloth,1.14)}" stroke="{EDGE}" stroke-width="1"/>')
    # 靠背上的分隔缝
    mid = b.t_point(0.5, 0.06)
    parts.append(f'<line x1="{mid[0]:.1f}" y1="{mid[1]-hb+2:.1f}" x2="{mid[0]:.1f}" y2="{mid[1]-2:.1f}" '
                 f'stroke="rgba(40,60,85,.3)" stroke-width="1.2"/>')
    # 扶手：两侧小方块
    for u in (0.03, 0.97):
        p0 = b.t_point(u, 0.86)
        parts.append(f'<ellipse cx="{p0[0]:.1f}" cy="{p0[1]:.1f}" rx="10" ry="6.5" fill="{mul(cloth,0.86)}" '
                     f'stroke="{EDGE}" stroke-width="1"/>')
    # 木脚
    for u in (0.1, 0.9):
        p0 = b.t_point(u, 0.92)
        parts.append(f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p0[0]:.1f}" y2="{p0[1]+6:.1f}" '
                     f'stroke="#7a5a34" stroke-width="3" stroke-linecap="round"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def lamp():
    b = Box(64, 8, top_y=62)     # 只做底座，杆和罩单独画
    cx = b.cx
    base_y = b.ay                # 落地点 = 底面菱形中心
    pole_h = 56
    parts = [b.shadow()]
    # 底座：圆盘
    parts.append(f'<ellipse cx="{cx}" cy="{base_y}" rx="13" ry="6.4" fill="#8a7f6e" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{cx}" cy="{base_y-2}" rx="13" ry="6.4" fill="#a89b86" stroke="{EDGE}" stroke-width="1"/>')
    # 灯杆
    parts.append(f'<rect x="{cx-1.6}" y="{base_y-pole_h}" width="3.2" height="{pole_h}" fill="#9a8d78"/>')
    # 灯罩：上窄下宽的梯形
    top_y = base_y - pole_h
    parts.append(f'<polygon points="{cx-9},{top_y-22} {cx+9},{top_y-22} {cx+17},{top_y+2} {cx-17},{top_y+2}" '
                 f'fill="#f2e6c8" stroke="rgba(120,100,70,.45)" stroke-width="1"/>')
    parts.append(f'<polygon points="{cx-9},{top_y-22} {cx+9},{top_y-22} {cx+6},{top_y-16} {cx-6},{top_y-16}" '
                 f'fill="#fdf6e4" stroke="none"/>')
    # 灯泡暖光
    parts.append(f'<ellipse cx="{cx}" cy="{top_y+2}" rx="9" ry="3.2" fill="rgba(255,226,150,.85)"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def plant():
    b = Box(64, 18, top_y=54)
    pot = '#b9743f'
    parts = [b.shadow()]
    # 花盆做成上宽下窄的斗形，比等距盒子更像盆
    cx, ty, h = b.cx, b.ty, b.half
    rim_y = ty + h          # 盆口前后方向的中心线
    top_w = b.W // 2 - 2
    bot_w = top_w - 7
    rim_f = (cx, ty + h * 2)          # 盆口前角
    rim_b = (cx, ty)                  # 盆口后角
    rim_l = (cx - top_w, ty + h)
    rim_r = (cx + top_w, ty + h)
    base_f = (cx, ty + h * 2 + b.H)
    base_l = (cx - bot_w, ty + h + b.H)
    base_r = (cx + bot_w, ty + h + b.H)
    parts.append(f'<polygon points="{rim_l[0]},{rim_l[1]} {rim_f[0]},{rim_f[1]} {base_f[0]},{base_f[1]} {base_l[0]},{base_l[1]}" '
                 f'fill="{mul(pot,0.74)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{rim_f[0]},{rim_f[1]} {rim_r[0]},{rim_r[1]} {base_r[0]},{base_r[1]} {base_f[0]},{base_f[1]}" '
                 f'fill="{mul(pot,0.92)}" stroke="{EDGE}" stroke-width="1"/>')
    # 盆口 + 土
    parts.append(f'<polygon points="{rim_l[0]},{rim_l[1]} {rim_b[0]},{rim_b[1]} {rim_r[0]},{rim_r[1]} {rim_f[0]},{rim_f[1]}" '
                 f'fill="{mul(pot,1.06)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{rim_l[0]+4},{rim_l[1]} {rim_b[0]},{rim_b[1]+4} {rim_r[0]-4},{rim_r[1]} {rim_f[0]},{rim_f[1]-4}" '
                 f'fill="#5b4630"/>')
    # 叶子：从盆口中心长出去的一丛，靠得近、有茎
    ox, oy = cx, ty + h
    def leaf(dx, dy, scale, rot, col):
        return (f'<g transform="translate({ox + dx},{oy + dy}) rotate({rot}) scale({scale})">'
                f'<path d="M0,0 C-7,-6 -8,-20 0,-28 C8,-20 7,-6 0,0 Z" fill="{col}" '
                f'stroke="rgba(35,70,40,.4)" stroke-width="1"/></g>')
    stems = [(-11, -6, -26), (11, -6, 26), (0, -12, 0), (-5, -2, -12), (6, -3, 14)]
    for dx, dy, rot in stems:
        parts.append(f'<line x1="{ox}" y1="{oy - 3}" x2="{ox + dx}" y2="{oy + dy - 8}" '
                     f'stroke="#4e8f5b" stroke-width="1.8" stroke-linecap="round"/>')
    parts.append(leaf(-11, -18, 0.92, -22, '#4e8f5b'))
    parts.append(leaf(11, -18, 0.92, 22, '#5da36a'))
    parts.append(leaf(0, -26, 1.02, 0, '#6fb37a'))
    parts.append(leaf(-4, -14, 0.74, -10, '#67a972'))
    parts.append(leaf(6, -15, 0.72, 12, '#579a63'))
    return svg(''.join(parts), b.W, b.total_h), b


def painting():
    b = Box(64, 4, top_y=70)
    cx = b.cx
    base_y = b.ay
    parts = [b.shadow()]
    # 三脚画架
    for dx, w in ((-14, 2.6), (14, 2.6), (0, 2.2)):
        parts.append(f'<line x1="{cx+dx*0.55:.1f}" y1="{base_y-46}" x2="{cx+dx:.1f}" y2="{base_y}" '
                     f'stroke="#a9865a" stroke-width="{w}" stroke-linecap="round"/>')
    # 画框
    fw, fh = 40, 32
    parts.append(f'<rect x="{cx-fw/2}" y="{base_y-46-fh}" width="{fw}" height="{fh}" fill="#f7f2e6" '
                 f'stroke="#8a6a3e" stroke-width="2.4"/>')
    # 画面：远山 + 太阳
    parts.append(f'<rect x="{cx-fw/2+3}" y="{base_y-46-fh+3}" width="{fw-6}" height="{fh-6}" fill="#cfe3ee"/>')
    parts.append(f'<path d="M{cx-fw/2+3},{base_y-24} L{cx-6},{base_y-46-fh+12} L{cx+3},{base_y-30} '
                 f'L{cx+9},{base_y-40} L{cx+fw/2-3},{base_y-24} Z" fill="#8fa9b8"/>')
    parts.append(f'<circle cx="{cx+10}" cy="{base_y-46-fh+10}" r="3.4" fill="#f2d98a"/>')
    parts.append(f'<rect x="{cx-fw/2+3}" y="{base_y-24}" width="{fw-6}" height="{base_y-46-fh+24-(base_y-24)}" fill="#a8c3a0"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def tv():
    b = Box(128, 22, top_y=48)
    wood = '#a98a5f'
    cx, ty, h = b.cx, b.ty, b.half
    sw, sh = 62, 34
    parts = [b.shadow()]
    # 屏幕先画、底边扎进柜面里：后画的柜子顶面会盖住屏幕底部，
    # 看起来就是"插在柜子上"，而不是悬浮在柜顶之上
    sy = ty + 20
    parts.append(f'<polygon points="{cx-sw/2},{sy} {cx+sw/2},{sy} {cx+sw/2},{sy-sh} {cx-sw/2},{sy-sh}" '
                 f'fill="#3a3f45" stroke="rgba(25,28,32,.75)" stroke-width="1.4"/>')
    parts.append(f'<rect x="{cx-sw/2+3}" y="{sy-sh+3}" width="{sw-6}" height="{sh-6}" fill="#6f93ad"/>')
    parts.append(f'<rect x="{cx-sw/2+3}" y="{sy-sh+3}" width="{sw-6}" height="8" fill="rgba(200,225,240,.4)"/>')
    parts.append(f'<rect x="{cx-9}" y="{sy-6}" width="18" height="6" fill="#2f3439"/>')
    # 柜体
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(wood,0.72)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(wood,0.9)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(wood,1.02)}" stroke="{EDGE}" stroke-width="1"/>')
    # 柜门缝
    parts.append(f'<polygon points="{b.r_quad(0.04,0.96,5,7)}" fill="{mul(wood,0.55)}"/>')
    p2 = b.top_pts().split()
    parts.append(f'<polyline points="{p2[3]} {p2[0]} {p2[1]}" fill="none" stroke="rgba(255,246,224,.5)" stroke-width="1.4"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def sink():
    b = Box(64, 40)
    cer = '#eef1f2'
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(cer,0.74)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(cer,0.9)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(cer,1.0)}" stroke="{EDGE}" stroke-width="1"/>')
    # 盆：顶面内缩的深色椭圆
    parts.append(b.t_ellipse(0.5, 0.55, 17, 9, 'fill="#cdd6da" stroke="rgba(120,130,140,.6)" stroke-width="1"'))
    parts.append(b.t_ellipse(0.5, 0.55, 14, 7, 'fill="#aab8bf"'))
    # 龙头
    cx2, cy2 = b.t_point(0.5, 0.18)
    parts.append(f'<rect x="{cx2-2}" y="{cy2-14}" width="4" height="15" fill="#9aa6b0" stroke="rgba(90,100,110,.6)" stroke-width="0.8"/>')
    parts.append(f'<rect x="{cx2-2}" y="{cy2-16}" width="11" height="4" fill="#9aa6b0" stroke="rgba(90,100,110,.6)" stroke-width="0.8"/>')
    # 台面高光
    p2 = b.top_pts().split()
    parts.append(f'<polyline points="{p2[3]} {p2[0]} {p2[1]}" fill="none" stroke="rgba(255,255,255,.7)" stroke-width="1.6"/>')
    return svg(''.join(parts), b.W, b.total_h), b



ITEMS = {
    'wardrobe': wardrobe, 'bookshelf': bookshelf, 'fridge': fridge,
    'stove': stove, 'dining': dining, 'shelf': shelf,
    'bed': bed, 'sofa': sofa, 'lamp': lamp, 'plant': plant,
    'painting': painting, 'tv': tv, 'sink': sink,
}


def write_into(html_path='2.5D小屋.html'):
    """把这 13 件写回 HTML 里的 FURN_SVG（其余家具保持手写版本不动）"""
    BT = chr(96)
    NL = chr(10)
    src = open(html_path, encoding='utf-8').read()
    n = 0
    for name, fn in ITEMS.items():
        s, b = fn()
        k = src.find('  ' + name + ': {w:')
        if k < 0:
            print('  跳过（HTML 里没有）', name); continue
        mark = 'svg:' + NL + BT
        sv = src.find(mark, k)
        start = sv + len(mark)
        end = src.find(BT, start)
        header = '  %s: {w:%d, h:%d, ax:%d, ay:%d, svg:%s%s' % (name, b.W, b.total_h, b.cx, b.ay, NL, BT)
        src = src[:k] + header + s + src[end:]
        n += 1
    open(html_path, 'w', encoding='utf-8', newline='').write(src)
    return n


if __name__ == '__main__':
    import sys
    if '--preview' in sys.argv:
        import json
        out = {}
        for name, fn in ITEMS.items():
            s, b = fn()
            out[name] = {'w': b.W, 'h': b.total_h, 'ax': b.cx, 'ay': b.ay, 'svg': s}
            print('%-11s %dx%d  ax=%d ay=%d' % (name, b.W, b.total_h, b.cx, b.ay))
        json.dump(out, open('.work/furn.json', 'w', encoding='utf-8'), ensure_ascii=False)
    else:
        n = write_into()
        print('已写回 %d 件家具到 2.5D小屋.html' % n)
