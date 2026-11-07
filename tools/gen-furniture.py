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


# ---------------------------------------------------------------- 补充工具

def group(inner, dx, dy):
    """把一段绝对坐标的内容整体平移。子部件（显示器、镜子）用它定位，
    比在每个坐标上手算偏移可靠得多。"""
    return f'<g transform="translate({dx:.1f},{dy:.1f})">{inner}</g>'


def leg_table(W, thick, leg_h, base, leg_inset=0.14, top_y=12, leg_w=3.6):
    """一块桌面 + 四条腿。

    锚点必须落在**腿底**而不是桌面底：等距里 ay 是"脚踩的那一点"，
    放在桌面底的话桌子会连着腿一起插进地板（desk / coffeetable 就是这么错的）。
    阴影同理，必须在 ay 定好之后才算。
    """
    b = Box(W, thick, top_y=top_y)
    # 先把锚点推到腿底，之后 b.shadow() 才落在正确位置
    b.ay = top_y + b.half + thick + leg_h
    b.total_h = b.ay + 12
    top, right, left = mul(base, 1.1), mul(base, 0.9), mul(base, 0.74)
    leg = mul(base, 0.56)
    parts = [b.shadow()]
    # 四条腿先画，桌面后画盖住腿根
    for (uu, side) in ((leg_inset, 'r'), (1 - leg_inset, 'r'),
                       (leg_inset, 'l'), (1 - leg_inset, 'l')):
        p0 = b.r_point(uu, b.H - 1) if side == 'r' else b.l_point(uu, b.H - 1)
        parts.append(f'<line x1="{p0[0]:.1f}" y1="{p0[1]:.1f}" x2="{p0[0]:.1f}" y2="{p0[1] + leg_h:.1f}" '
                     f'stroke="{leg}" stroke-width="{leg_w}" stroke-linecap="round"/>')
    parts.append(f'<polygon points="{b.left_face()}" fill="{left}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{right}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{top}" stroke="{EDGE}" stroke-width="1"/>')
    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" '
                 f'stroke="rgba(255,246,224,.5)" stroke-width="1.4"/>')
    return parts, b


def vertical_panel(b, edge, height, color, stroke=EDGE, thickness=3.2):
    """在顶面某条边上立一块竖直薄板（显示器 / 镜子 / 床头板）。

    edge: 'back' 沿"左角→后角"，'right' 沿"后角→右角"。
    板面本身就是等距侧面，所以竖起来才像"插在桌上"，而不是贴一张图。
    """
    cx, ty, h, W = b.cx, b.ty, b.half, b.W
    if edge == 'back':
        p0 = (cx - W // 2, ty + h)          # 左角
        p1 = (cx, ty)                        # 后角
    else:
        p0 = (cx, ty)                        # 后角
        p1 = (cx + W // 2, ty + h)           # 右角
    light = mul(color, 1.12)
    dark = mul(color, 0.88)
    # 顶面（薄板的上沿，露出厚度）
    tx, ty2 = (p1[0] - p0[0]) * 0.06, (p1[1] - p0[1]) * 0.06
    out = []
    out.append(f'<polygon points="{p0[0]:.1f},{p0[1] - height:.1f} {p1[0]:.1f},{p1[1] - height:.1f} '
               f'{p1[0] + tx:.1f},{p1[1] - height - thickness:.1f} {p0[0] + tx:.1f},{p0[1] - height - thickness:.1f}" '
               f'fill="{light}" stroke="{stroke}" stroke-width="0.8"/>')
    # 板面
    out.append(f'<polygon points="{p0[0]:.1f},{p0[1] - height:.1f} {p1[0]:.1f},{p1[1] - height:.1f} '
               f'{p1[0]:.1f},{p1[1]:.1f} {p0[0]:.1f},{p0[1]:.1f}" '
               f'fill="{dark}" stroke="{stroke}" stroke-width="1"/>')
    return ''.join(out)


def panel_rect(b, edge, height, u0, u1, d0, d1, fill, stroke='none', sw=0.8):
    """在 vertical_panel 那块板上再画一个矩形区域（屏幕 / 镜面）。
    u 沿板的横向 0..1，d 是从板顶往下（0 = 顶, height = 板底）。"""
    cx, ty, h, W = b.cx, b.ty, b.half, b.W
    if edge == 'back':
        p0 = (cx - W // 2, ty + h); p1 = (cx, ty)
    else:
        p0 = (cx, ty); p1 = (cx + W // 2, ty + h)
    def pt(u, d):
        x = p0[0] + (p1[0] - p0[0]) * u
        y = p0[1] + (p1[1] - p0[1]) * u - height + d
        return x, y
    a = pt(u0, d0); bb = pt(u1, d0); c = pt(u1, d1); dd = pt(u0, d1)
    return (f'<polygon points="{a[0]:.1f},{a[1]:.1f} {bb[0]:.1f},{bb[1]:.1f} '
            f'{c[0]:.1f},{c[1]:.1f} {dd[0]:.1f},{dd[1]:.1f}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')


def panel_on_top(b, u0, u1, v, height, color, thickness=3.6):
    """在顶面上立一块竖直面板，底边沿 +x 方向、落在顶面**中部**（不贴任何一条边）。

    为什么不用贴边的 vertical_panel：底边压在菱形边上时，板子的左端正好是
    整个家具最左的点，投出来就是"柜子背后斜插着一块板"。
    落在中间，面板的轮廓完全在顶面菱形之内，才读得出"站在台面上"。
    """
    p0 = b.t_point(u0, v)
    p1 = b.t_point(u1, v)
    light = mul(color, 1.15)
    # 顶边厚度：**纯竖直**的窄带。
    # 之前按 (p1-p0)*0.05 往右偏，左端就比面板本体多出一截，顶上切出一个尖角。
    out = []
    out.append(f'<polygon points="{p0[0]:.1f},{p0[1] - height:.1f} {p1[0]:.1f},{p1[1] - height:.1f} '
               f'{p1[0]:.1f},{p1[1] - height - thickness:.1f} {p0[0]:.1f},{p0[1] - height - thickness:.1f}" '
               f'fill="{light}" stroke="{EDGE}" stroke-width="0.9"/>')
    # 正面
    out.append(f'<polygon points="{p0[0]:.1f},{p0[1] - height:.1f} {p1[0]:.1f},{p1[1] - height:.1f} '
               f'{p1[0]:.1f},{p1[1]:.1f} {p0[0]:.1f},{p0[1]:.1f}" '
               f'fill="{color}" stroke="{EDGE}" stroke-width="1"/>')
    return ''.join(out)


def panel_on_top_rect(b, u0, u1, v, height, au0, au1, d0, d1, fill, stroke='none', sw=0.8):
    """在上面那块面板上再画一个矩形（屏幕 / 镜面）。
    au 是横向 0..1（相对 u0..u1），d 是从面板顶往下。"""
    p0 = b.t_point(u0, v)
    p1 = b.t_point(u1, v)
    def pt(t, d):
        return (p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t - height + d)
    a = pt(au0, d0); bb = pt(au1, d0); c = pt(au1, d1); dd = pt(au0, d1)
    return (f'<polygon points="{a[0]:.1f},{a[1]:.1f} {bb[0]:.1f},{bb[1]:.1f} '
            f'{c[0]:.1f},{c[1]:.1f} {dd[0]:.1f},{dd[1]:.1f}" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>')


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
    # 锚点先推到腿底，再算阴影——顺序反了的话影子会落在桌面高度、而桌子插进地板
    b.ay += leg_h
    b.total_h += leg_h
    parts = [b.shadow()]
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
    """电视柜：柜体 + 一块立在柜顶**中部**的屏幕。

    三个版本的经验：
      ① 屏幕先画、底边穿进柜顶 → 柜顶盖掉下半截，像"柜子背后立着相框"
      ② 沿柜顶后边按等距立起来 → 底边压在菱形边上，板子左端就是全图最左点，
         投出来还是"背后斜插一块板"
      ③ 轴对齐矩形 → 和等距透视打架，读成"平躺在柜面上"
    最终：底边沿等距 +x 方向、落在顶面中部（u 0.12..0.86, v 0.30），
    轮廓完全收在菱形里，才看得出是"站在柜面上的电视"。
    """
    b = Box(128, 26, top_y=52)
    wood = '#b08a5a'
    cx, ty, h = b.cx, b.ty, b.half
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(wood, 0.72)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(wood, 0.9)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{mul(wood, 1.04)}" stroke="{EDGE}" stroke-width="1"/>')
    # 两扇柜门
    for (u0, u1) in ((0.05, 0.47), (0.53, 0.95)):
        parts.append(f'<polygon points="{b.r_quad(u0, u1, 5, b.H - 5)}" fill="{mul(wood, 0.95)}" '
                     f'stroke="rgba(58,40,22,.3)" stroke-width="1"/>')
        px, py = b.r_point((u0 + u1) / 2, b.H * 0.5)
        parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="1.6" fill="#6b5636"/>')
    parts.append(f'<polygon points="{b.l_quad(0.46, 0.54, 4, b.H - 4)}" fill="{mul(wood, 0.62)}" opacity=".5"/>')

    # 屏幕：底边落在顶面中部
    sh = 40
    u0, u1, v = 0.14, 0.86, 0.30
    # 先压一层接触阴影，把屏幕"焊"在柜面上
    bx, by = b.t_point((u0 + u1) / 2, v)
    parts.append(f'<ellipse cx="{bx:.1f}" cy="{by + 2:.1f}" rx="30" ry="7" fill="rgba(58,40,22,.16)"/>')
    parts.append(panel_on_top(b, u0, u1, v, sh, '#2f353a', thickness=4))
    # 屏面
    parts.append(panel_on_top_rect(b, u0, u1, v, sh, 0.05, 0.95, 4, sh - 4, '#6f93ad', 'rgba(20,26,32,.6)', 1))
    # 画面：上方天光 + 下方山影
    parts.append(panel_on_top_rect(b, u0, u1, v, sh, 0.05, 0.95, 4, 15, 'rgba(198,226,240,.6)'))
    parts.append(panel_on_top_rect(b, u0, u1, v, sh, 0.18, 0.60, 18, sh - 5, 'rgba(108,142,166,.45)'))
    # 底座横条
    parts.append(panel_on_top_rect(b, u0, u1, v, sh, 0.40, 0.60, sh - 5, sh, '#23282c'))
    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" stroke="rgba(255,246,224,.5)" stroke-width="1.4"/>')
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


def bathtub():
    """浴缸：缸壁要有厚度，不然读成一个白托盘。
    做法是顶面画成"环"——外圈是缸沿，内圈压深色当内壁，水面再内缩一点、略微下沉。"""
    W, H = 128, 30
    b = Box(W, H)
    rim = '#f2f4f4'
    cx, ty, h = b.cx, b.ty, b.half     # 早绑定：下面几处都要用，别留到函数末尾才赋值
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="{mul(rim, 0.8)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="{mul(rim, 0.91)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="{rim}" stroke="{EDGE}" stroke-width="1"/>')

    def inset_pts(k, dy=0):
        # 顶面菱形按比例 k 向中心收，dy 是整体下移（模拟"往下看"的深度）
        cx, ty, h = b.cx, b.ty, b.half
        pts = [(cx, ty), (cx + W // 2, ty + h), (cx, ty + h * 2), (cx - W // 2, ty + h)]
        out = []
        for (x, y) in pts:
            out.append((cx + (x - cx) * k, (ty + h) + (y - (ty + h)) * k + dy))
        return ' '.join(f'{x:.1f},{y:.1f}' for x, y in out)

    # 内壁：只收 8%，缸沿别太宽（太宽就成了"托盘"）
    parts.append(f'<polygon points="{inset_pts(0.90, 5)}" fill="#c9d4d8" stroke="rgba(90,105,110,.45)" stroke-width="1"/>')
    # 水面用**椭圆**而不是菱形：浴缸是圆底的，菱形会读成"水槽"
    wcx, wcy = b.cx, b.ty + h + 6
    parts.append(f'<ellipse cx="{wcx}" cy="{wcy}" rx="48" ry="21" fill="#b3d6e4" '
                 f'stroke="rgba(120,160,178,.45)" stroke-width="1.2"/>')
    parts.append(f'<ellipse cx="{wcx}" cy="{wcy + 1}" rx="44" ry="18.5" fill="#9ccadd"/>')
    # 远侧（上沿）压一点暗，读成"水面比缸沿低"
    parts.append(f'<path d="M{wcx - 40},{wcy - 12} Q{wcx},{wcy - 24} {wcx + 40},{wcy - 12}" fill="none" '
                 f'stroke="rgba(90,130,150,.28)" stroke-width="5"/>')
    # 水面反光：两道短弧（直线会像"水面裂了"）
    for (dx, dy, r) in ((-18, 2, 12), (6, 6, 9)):
        parts.append(f'<path d="M{cx + dx - r},{ty + h + dy} Q{cx + dx},{ty + h + dy - 5} {cx + dx + r},{ty + h + dy}" '
                     f'fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2" stroke-linecap="round"/>')
    # 排水口
    parts.append(f'<ellipse cx="{cx + 26}" cy="{ty + h + 10}" rx="4.4" ry="2.4" fill="rgba(120,140,150,.55)"/>')
    # 缸沿高光
    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" stroke="rgba(255,255,255,.8)" stroke-width="1.8"/>')
    # 水龙头（靠后沿）
    fx, fy = b.t_point(0.16, 0.16)
    parts.append(f'<rect x="{fx - 2:.1f}" y="{fy - 15:.1f}" width="4" height="16" fill="#9aa6b0" '
                 f'stroke="rgba(80,90,100,.55)" stroke-width="0.9"/>')
    parts.append(f'<rect x="{fx - 2:.1f}" y="{fy - 17:.1f}" width="12" height="4" rx="1.6" fill="#b3bfc7" '
                 f'stroke="rgba(80,90,100,.55)" stroke-width="0.9"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def toilet():
    """马桶：后水箱 + 咬合在一起的盆沿和盖板 + 窄柱底座。

    前三版的失败点：
      ① 把 64×30 的整块立方体当底座，上面贴两张白纸 → "方块上放着卡片"
      ② 盖板立起来 → 读成"一台老式显示器"
      ③ 水箱 26×26 几乎和便盆一样大、两者只贴边不重叠 → "一个盒子搁在盘子上"
    核心是**咬合**：水箱的下沿要压进盆沿里 6~8px，两者才是同一件东西。
    """
    W = 64
    cx = W // 2
    cer = '#f4f6f6'

    # 纵向锚点（屏幕 y，从远到近）：水箱 20..42，便盆中心 48，落地 68
    tank_top = 20
    tank_h = 22
    tank_bot = tank_top + tank_h
    bowl_cy = 48
    ground = 68
    parts = []

    # ① 窄柱底座：先画，柱顶藏在盆沿下面
    parts.append(f'<path d="M{cx - 8},{ground} L{cx - 6},{bowl_cy + 5} L{cx + 6},{bowl_cy + 5} L{cx + 8},{ground}" '
                 f'fill="{mul(cer, 0.84)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{cx}" cy="{ground}" rx="8" ry="3.8" fill="{mul(cer, 0.77)}" stroke="{EDGE}" stroke-width="1"/>')

    # ② 后水箱：24 宽，比便盆（34）窄一圈，下沿压进盆沿
    tw = 24
    parts.append(f'<rect x="{cx - tw // 2}" y="{tank_top}" width="{tw}" height="{tank_h}" rx="2" '
                 f'fill="{mul(cer, 0.92)}" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<rect x="{cx - tw // 2}" y="{tank_top}" width="{tw}" height="4.2" rx="2" '
                 f'fill="{mul(cer, 1.08)}" stroke="{EDGE}" stroke-width="0.9"/>')
    # 左侧暗面
    parts.append(f'<rect x="{cx - tw // 2}" y="{tank_top + 4.2}" width="5" height="{tank_h - 4.2}" '
                 f'fill="rgba(138,156,164,.20)"/>')
    # 冲水按钮
    parts.append(f'<ellipse cx="{cx + 5}" cy="{tank_top + 10}" rx="3.4" ry="1.7" fill="#c4ced2" '
                 f'stroke="rgba(120,135,140,.5)" stroke-width="0.7"/>')

    # ③ 盆沿：外深内白两层，下沿压住柱顶
    parts.append(f'<ellipse cx="{cx}" cy="{bowl_cy + 1}" rx="17" ry="8.6" fill="{mul(cer, 0.86)}" '
                 f'stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{cx}" cy="{bowl_cy}" rx="17" ry="8.6" fill="#ffffff" '
                 f'stroke="rgba(118,133,138,.5)" stroke-width="1"/>')

    # ④ 盖板：合着，正好盖住盆口，比盆沿小 3px
    parts.append(f'<ellipse cx="{cx}" cy="{bowl_cy - 1}" rx="14.2" ry="7" fill="{mul(cer, 1.01)}" '
                 f'stroke="rgba(122,138,144,.6)" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{cx}" cy="{bowl_cy - 1}" rx="9.6" ry="4.4" fill="none" '
                 f'stroke="rgba(152,170,176,.4)" stroke-width="0.9"/>')
    # 铰链缝：贴水箱那一侧的一道浅弧
    parts.append(f'<path d="M{cx - 11},{bowl_cy - 5} Q{cx},{bowl_cy - 9} {cx + 11},{bowl_cy - 5}" fill="none" '
                 f'stroke="rgba(132,148,154,.5)" stroke-width="1"/>')

    b = Box(W, 20, top_y=tank_top)
    b.ay = ground - 2
    b.total_h = ground + 10
    parts.insert(0, b.shadow())
    return svg(''.join(parts), b.W, b.total_h), b


def desk():
    """书桌：桌面 + 四条腿，锚点在腿底。"""
    parts, b = leg_table(128, 11, 34, '#c89559')
    # 桌面上：一叠纸 + 一支笔
    for k in range(3):
        x, y = b.t_point(0.3 + k * 0.02, 0.5 - k * 0.03)
        parts.append(f'<polygon points="{x - 13:.1f},{y:.1f} {x + 13:.1f},{y + 13:.1f} '
                     f'{x + 21:.1f},{y + 9:.1f} {x - 5:.1f},{y - 4:.1f}" fill="#f8f5ec" '
                     f'stroke="rgba(150,138,116,.55)" stroke-width="0.9"/>')
    px, py = b.t_point(0.62, 0.62)
    parts.append(f'<line x1="{px:.1f}" y1="{py:.1f}" x2="{px + 16:.1f}" y2="{py + 8:.1f}" '
                 f'stroke="#3f6a8e" stroke-width="2.4" stroke-linecap="round"/>')
    # 抽屉（右面）
    parts.append(f'<polygon points="{b.r_quad(0.06, 0.94, 2, 8)}" fill="{mul("#c89559", 0.62)}"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def coffeetable():
    """茶几：矮桌面 + 短腿。"""
    parts, b = leg_table(128, 9, 16, '#be955f', leg_inset=0.1, leg_w=3.2)
    # 下层隔板
    y0 = b.ty + b.W // 2 + b.H + 8
    cx = b.cx
    parts.insert(1, f'<polygon points="{cx - 44},{y0} {cx},{y0 + 22} {cx + 44},{y0} {cx},{y0 - 22}" '
                    f'fill="{mul("#be955f", 0.8)}" stroke="{EDGE}" stroke-width="1"/>')
    # 上面放一本书和一只杯子
    x, y = b.t_point(0.34, 0.5)
    parts.append(f'<polygon points="{x - 12:.1f},{y:.1f} {x + 12:.1f},{y + 12:.1f} '
                 f'{x + 18:.1f},{y + 8:.1f} {x - 6:.1f},{y - 4:.1f}" fill="#a8503f" '
                 f'stroke="rgba(80,40,30,.5)" stroke-width="0.9"/>')
    ux, uy = b.t_point(0.68, 0.56)
    parts.append(f'<ellipse cx="{ux:.1f}" cy="{uy:.1f}" rx="6" ry="3.2" fill="#f7f2e8" stroke="rgba(140,130,110,.5)" stroke-width="0.8"/>')
    parts.append(f'<rect x="{ux - 6:.1f}" y="{uy - 5:.1f}" width="12" height="5" fill="#8a6bb5"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def pc():
    """电脑桌：桌腿落地 + 显示器支架踩在桌面 + 键盘是薄板。
    原来显示器整体平移画在桌面上方，中间留了 9px 空隙，看着就是"浮着的相框"。"""
    parts, b = leg_table(128, 11, 32, '#b98a4e', top_y=50)   # 显示器要占 66px 高
    cx, ty, h = b.cx, b.ty, b.half
    # 显示器：底座 + 立柱 + 屏幕，全部从桌面往上长
    base_x, base_y = b.t_point(0.5, 0.34)
    b.ay  # 保持引用，避免误删
    sw, sh = 54, 34
    # 屏幕底边要穿过底座那一点：等距下底边是斜的，若按"矩形左上角"定位，
    # 左端会比底座高出一大截，看起来就是显示器浮在半空（上一版差 21px）。
    bx0 = base_x - sw // 2
    by0 = base_y - sw / 4
    parts.append(f'<polygon points="{bx0:.1f},{by0:.1f} {bx0 + sw:.1f},{by0 + sw / 2:.1f} '
                 f'{bx0 + sw:.1f},{by0 + sw / 2 - sh:.1f} {bx0:.1f},{by0 - sh:.1f}" '
                 f'fill="#2f3439" stroke="rgba(20,24,28,.8)" stroke-width="1.4"/>')
    # 屏幕内容
    parts.append(f'<polygon points="{bx0 + 3:.1f},{by0 - 2:.1f} {bx0 + sw - 3:.1f},{by0 + sw / 2 - 2:.1f} '
                 f'{bx0 + sw - 3:.1f},{by0 + sw / 2 - sh + 3:.1f} {bx0 + 3:.1f},{by0 - sh + 3:.1f}" '
                 f'fill="#5b87a8"/>')
    parts.append(f'<polygon points="{bx0 + 3:.1f},{by0 - 2:.1f} {bx0 + sw - 3:.1f},{by0 + sw / 2 - 2:.1f} '
                 f'{bx0 + sw - 3:.1f},{by0 + sw / 2 - sh + 12:.1f} {bx0 + 3:.1f},{by0 - sh + 12:.1f}" '
                 f'fill="rgba(190,222,240,.35)"/>')
    # 立柱与底座
    parts.append(f'<rect x="{base_x - 2.4:.1f}" y="{base_y - 8:.1f}" width="4.8" height="8" fill="#3a4046"/>')
    parts.append(f'<ellipse cx="{base_x:.1f}" cy="{base_y - 1:.1f}" rx="15" ry="7" fill="#3a4046" '
                 f'stroke="rgba(20,24,28,.7)" stroke-width="1"/>')
    # 键盘
    kx, ky = b.t_point(0.5, 0.66)
    parts.append(f'<polygon points="{kx - 22:.1f},{ky:.1f} {kx + 4:.1f},{ky + 13:.1f} '
                 f'{kx + 22:.1f},{ky + 4:.1f} {kx - 4:.1f},{ky - 9:.1f}" '
                 f'fill="#e6e3da" stroke="rgba(120,112,96,.55)" stroke-width="1"/>')
    for k in range(3):
        parts.append(f'<line x1="{kx - 14 + k * 5:.1f}" y1="{ky + 2 + k * 1.5:.1f}" '
                     f'x2="{kx - 2 + k * 5:.1f}" y2="{ky + 8 + k * 1.5:.1f}" '
                     f'stroke="rgba(120,112,96,.5)" stroke-width="0.8"/>')
    # 鼠标
    mx, my = b.t_point(0.74, 0.6)
    parts.append(f'<ellipse cx="{mx:.1f}" cy="{my:.1f}" rx="4.4" ry="2.6" fill="#d8d5cc" stroke="rgba(120,112,96,.5)" stroke-width="0.8"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def vanity():
    """梳妆台：桌子 + 立在"左后边"上的镜子。
    镜子必须沿顶面某条边立起来（板面是等距侧面），浮在后边缘外面的那版读成"插了张纸"。"""
    parts, b = leg_table(128, 12, 26, '#c08b6a', leg_inset=0.12, top_y=52)  # 镜面 40 高
    # 镜子立在 back 边（左角 → 后角）
    mir_h = 40
    parts.append(vertical_panel(b, 'back', mir_h, '#8a6a52', thickness=3.4))
    # 镜面
    parts.append(panel_rect(b, 'back', mir_h, 0.14, 0.86, 5, mir_h - 5, '#cfe0e8',
                            'rgba(120,140,150,.5)', 1.2))
    # 镜面反光：两条斜纹必须画在镜子那块板里，落到桌面上就成了"台面多了一道白线"
    parts.append(panel_rect(b, 'back', mir_h, 0.28, 0.4, 10, mir_h - 8, 'rgba(255,255,255,.55)'))
    parts.append(panel_rect(b, 'back', mir_h, 0.46, 0.54, 14, mir_h - 6, 'rgba(255,255,255,.32)'))
    # 台面上：三只小瓶
    for k, (u, v, col) in enumerate(((0.5, 0.55, '#c96f8a'), (0.62, 0.66, '#7fa8c4'), (0.72, 0.54, '#c9a15e'))):
        x, y = b.t_point(u, v)
        hh = 8 + k * 2
        parts.append(f'<rect x="{x - 3.4:.1f}" y="{y - hh:.1f}" width="6.8" height="{hh}" rx="1.6" '
                     f'fill="{col}" stroke="rgba(80,60,50,.35)" stroke-width="0.8"/>')
        parts.append(f'<rect x="{x - 1.4:.1f}" y="{y - hh - 3:.1f}" width="2.8" height="3" fill="#5a4a3a"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def stereo():
    """音响：深色箱体 + 两个喇叭 + 一根短天线。

    手写版有两个问题：天线从 (50,10) 拉到 (60,0) 直接冲出画布右上角（截图里那道
    "扇叶"就是它），阴影画在 y=66 而锚点在 52——影子沉在箱体下面 14px。
    """
    b = Box(64, 26)
    cx, ty, h = b.cx, b.ty, b.half
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="#2f353c" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="#3c434b" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="#525b66" stroke="{EDGE}" stroke-width="1"/>')

    # 左右两个喇叭：圆心落在各自的侧面上
    lx, ly = b.l_point(0.52, b.H * 0.5)
    parts.append(f'<ellipse cx="{lx:.1f}" cy="{ly:.1f}" rx="7" ry="6.4" fill="#1c2025" stroke="#59616b" stroke-width="1"/>')
    parts.append(f'<ellipse cx="{lx:.1f}" cy="{ly:.1f}" rx="3.2" ry="2.9" fill="#31383f"/>')
    rx, ry = b.r_point(0.52, b.H * 0.5)
    parts.append(f'<ellipse cx="{rx:.1f}" cy="{ry:.1f}" rx="8" ry="7.2" fill="#1c2025" stroke="#6b7480" stroke-width="1.2"/>')
    parts.append(f'<ellipse cx="{rx:.1f}" cy="{ry:.1f}" rx="4.2" ry="3.8" fill="#31383f"/>')
    parts.append(f'<ellipse cx="{rx:.1f}" cy="{ry:.1f}" rx="1.8" ry="1.6" fill="#6b7480"/>')

    # 电源灯：放在顶面，靠前一点，别浮在箱体外面
    px, py = b.t_point(0.62, 0.4)
    parts.append(f'<circle cx="{px:.1f}" cy="{py:.1f}" r="1.8" fill="#7ce38b"/>')

    # 天线：从顶面后部斜向上，长度控制在画布内
    ax, ay = b.t_point(0.5, 0.2)
    parts.append(f'<line x1="{ax:.1f}" y1="{ay:.1f}" x2="{ax + 9:.1f}" y2="{ay - 15:.1f}" '
                 f'stroke="#8b939e" stroke-width="1.8" stroke-linecap="round"/>')
    parts.append(f'<circle cx="{ax + 9:.1f}" cy="{ay - 15:.1f}" r="1.5" fill="#8b939e"/>')

    p = b.top_pts().split()
    parts.append(f'<polyline points="{p[3]} {p[0]} {p[1]}" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="1.2"/>')
    return svg(''.join(parts), b.W, b.total_h), b


def chair():
    """椅子：薄座面 + 四条腿 + 贴在后边上的靠背。

    手写版把靠背画成一块斜板放在座面**之后**，两者没有接触，
    整件读成"一张小桌上斜靠着一块木板"。
    """
    parts, b = leg_table(64, 8, 15, '#8e9aa8', leg_inset=0.1, top_y=34, leg_w=3)
    # 靠背：沿 back 边（左角 → 后角）立起来，宽度略收
    parts.append(vertical_panel(b, 'back', 24, '#7b8794', thickness=3))
    # 靠背上的横档
    cx, ty, h = b.cx, b.ty, b.half
    parts.append(f'<polygon points="{cx - 24},{ty + h - 14} {cx},{ty - 14} {cx},{ty - 10} {cx - 24},{ty + h - 10}" '
                 f'fill="{mul("#7b8794", 0.8)}"/>')
    # 座面坐垫：比座面小一圈的浅色椭圆
    parts.append(b.t_ellipse(0.5, 0.56, 20, 10, 'fill="#a8b4c0" stroke="rgba(60,80,100,.28)" stroke-width="1"'))
    return svg(''.join(parts), b.W, b.total_h), b


def shower():
    """淋浴间：底盘 + 两块玻璃 + 从后边立起来的喷头管。

    手写版把喷头挂在一根细线顶端，那根线没连到底盘，喷头就"飞"在盒外。
    """
    base = Box(128, 12, top_y=44)   # 玻璃 + 喷头要占 26+ 的上方空间
    parts = [base.shadow()]
    # 底盘
    parts.append(f'<polygon points="{base.left_face()}" fill="#dfe6e9" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{base.right_face()}" fill="#eef3f5" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{base.top_pts()}" fill="#f7fafb" stroke="{EDGE}" stroke-width="1"/>')
    cx, ty, h = base.cx, base.ty, base.half
    # 地漏
    parts.append(base.t_ellipse(0.5, 0.5, 7, 3.4, 'fill="#c9d3d8" stroke="rgba(120,140,150,.5)" stroke-width="1"'))

    # 两块玻璃：沿 back 边与 right 边立起，高 26
    gh = 26
    p0 = (cx - 64, ty + h); p1 = (cx, ty); p2 = (cx + 64, ty + h)
    parts.append(f'<polygon points="{p0[0]},{p0[1] - gh} {p1[0]},{p1[1] - gh} {p1[0]},{p1[1]} {p0[0]},{p0[1]}" '
                 f'fill="rgba(168,210,226,.55)" stroke="rgba(112,155,175,.8)" stroke-width="1.4"/>')
    parts.append(f'<polygon points="{p1[0]},{p1[1] - gh} {p2[0]},{p2[1] - gh} {p2[0]},{p2[1]} {p1[0]},{p1[1]}" '
                 f'fill="rgba(168,210,226,.38)" stroke="rgba(112,155,175,.7)" stroke-width="1.4"/>')
    # 玻璃上的反光斜纹
    parts.append(f'<polygon points="{p0[0] + 12},{p0[1] - gh + 6} {p0[0] + 22},{p0[1] - gh + 6} '
                 f'{p0[0] + 6},{p0[1] - 6} {p0[0] - 4},{p0[1] - 6}" fill="rgba(255,255,255,.45)"/>')

    # 喷头：从后边立一根管，管头出横臂，末端是花洒
    px, py = cx, ty - gh + 8
    parts.append(f'<line x1="{px}" y1="{py}" x2="{px}" y2="{py + gh - 4}" stroke="#9aa8b2" stroke-width="2.6" '
                 f'stroke-linecap="round"/>')
    parts.append(f'<line x1="{px}" y1="{py}" x2="{px + 14}" y2="{py + 7}" stroke="#9aa8b2" stroke-width="2.4" '
                 f'stroke-linecap="round"/>')
    parts.append(f'<ellipse cx="{px + 15}" cy="{py + 8}" rx="7" ry="3.4" fill="#b8c6d0" '
                 f'stroke="rgba(110,130,140,.6)" stroke-width="1"/>')
    for k in range(3):
        parts.append(f'<line x1="{px + 11 + k * 3}" y1="{py + 11}" x2="{px + 11 + k * 3}" y2="{py + 17}" '
                     f'stroke="rgba(150,190,210,.75)" stroke-width="1.2" stroke-linecap="round"/>')
    return svg(''.join(parts), base.W, base.total_h + gh), base


def waterdisp():
    """饮水机：机身 + 有瓶颈的桶。

    手写版那个桶是个大蓝球，像一颗飘在机顶的泡泡。加上瓶颈和上窄下宽的形状，
    才读得出是"倒插在饮水机上的水桶"。
    """
    b = Box(64, 36, top_y=34)
    cx, ty, h = b.cx, b.ty, b.half
    parts = [b.shadow()]
    parts.append(f'<polygon points="{b.left_face()}" fill="#dfe4e8" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.right_face()}" fill="#eef2f5" stroke="{EDGE}" stroke-width="1"/>')
    parts.append(f'<polygon points="{b.top_pts()}" fill="#f8fbfc" stroke="{EDGE}" stroke-width="1"/>')
    # 接水槽
    parts.append(f'<polygon points="{b.l_quad(0.34, 0.66, 10, 20)}" fill="#c4ced4" stroke="rgba(120,140,150,.5)" stroke-width="1"/>')
    # 两个龙头
    parts.append(f'<circle cx="{cx - 9}" cy="{ty + h + 6}" r="2.6" fill="#c8503f"/>')
    parts.append(f'<circle cx="{cx + 8}" cy="{ty + h + 3}" r="2.6" fill="#3f78c8"/>')
    # 水桶：倒插在机顶（瓶颈朝下）。24 宽 26 高——再宽就成了漏斗
    jug_y = ty + h - 2
    neck_h, body_h = 10, 26
    parts.append(f'<rect x="{cx - 3}" y="{jug_y - neck_h}" width="6" height="{neck_h}" fill="#a8cfe0" '
                 f'stroke="rgba(110,150,170,.6)" stroke-width="0.9"/>')
    parts.append(f'<path d="M{cx - 3},{jug_y - neck_h} Q{cx - 12},{jug_y - neck_h - 6} {cx - 12},{jug_y - neck_h - body_h} '
                 f'L{cx + 12},{jug_y - neck_h - body_h} Q{cx + 12},{jug_y - neck_h - 6} {cx + 3},{jug_y - neck_h} Z" '
                 f'fill="#a8cfe0" stroke="rgba(110,150,170,.65)" stroke-width="1.1"/>')
    top_y2 = jug_y - neck_h - body_h
    # 桶顶是**圆顶**不是敞口：亮椭圆+深内圈会被读成"一个杯子"。
    # 倒插的水桶，朝上那一面其实是桶底，是实心的。
    parts.append(f'<path d="M{cx - 12},{top_y2} Q{cx - 12},{top_y2 - 8} {cx},{top_y2 - 8} '
                 f'Q{cx + 12},{top_y2 - 8} {cx + 12},{top_y2} Z" fill="#b6dbe9" '
                 f'stroke="rgba(110,150,170,.55)" stroke-width="1"/>')
    # 桶身上的水面（在侧面看是一条弧形亮带）
    parts.append(f'<path d="M{cx - 11.5},{top_y2 + 9} Q{cx},{top_y2 + 2} {cx + 11.5},{top_y2 + 9}" '
                 f'fill="none" stroke="rgba(255,255,255,.55)" stroke-width="2"/>')
    parts.append(f'<path d="M{cx - 8},{top_y2 + 5} Q{cx - 10},{jug_y - neck_h - 12} {cx - 6},{jug_y - neck_h - 4}" '
                 f'fill="none" stroke="rgba(255,255,255,.7)" stroke-width="2" stroke-linecap="round"/>')
    return svg(''.join(parts), b.W, b.total_h), b


ITEMS = {
    'wardrobe': wardrobe, 'bookshelf': bookshelf, 'fridge': fridge,
    'stove': stove, 'dining': dining, 'shelf': shelf,
    'bed': bed, 'sofa': sofa, 'lamp': lamp, 'plant': plant,
    'painting': painting, 'tv': tv, 'sink': sink,
    # 第二批：原来手写的 7 件，几何/锚点/阴影都没跟上统一规范
    'bathtub': bathtub, 'toilet': toilet, 'desk': desk,
    'coffeetable': coffeetable, 'pc': pc, 'vanity': vanity,
    'stereo': stereo, 'chair': chair, 'shower': shower, 'waterdisp': waterdisp,
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
