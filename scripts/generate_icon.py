"""
Generate a professional, ultra-high-definition 512x512 icon for AG-Wormhole.
Features:
- Dual-Plane Torus Wormhole Swirl (Local: Electric Cyan/Emerald, Remote: Quantum Violet/Magenta)
- High-dynamic-range Singularity Core with Bloom & Glow
- Deep Space Squircle Container with Holographic Border
"""

import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 512
CENTER = SIZE / 2

# 1. Initialize RGBA canvas
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

# 2. Draw Squircle Background with Gradient
# Create base mask for squircle
mask = Image.new("L", (SIZE, SIZE), 0)
draw_mask = ImageDraw.Draw(mask)
pad = 20
radius = 110
draw_mask.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=radius, fill=255)

# Gradient background (Cosmic Dark Radial)
bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
y_coords, x_coords = np.ogrid[:SIZE, :SIZE]
dist_from_top_center = np.sqrt((x_coords - CENTER) ** 2 + (y_coords - CENTER * 0.7) ** 2)
max_dist = np.sqrt(CENTER ** 2 + (CENTER * 1.3) ** 2)
t = np.clip(dist_from_top_center / max_dist, 0.0, 1.0)

# Radial gradient: #1a2233 -> #0c101a -> #05070c
r = (1.0 - t) * 26 + t * 5
g = (1.0 - t) * 34 + t * 7
b = (1.0 - t) * 51 + t * 12
bg_array = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
bg_array[:, :, 0] = r.astype(np.uint8)
bg_array[:, :, 1] = g.astype(np.uint8)
bg_array[:, :, 2] = b.astype(np.uint8)
bg_array[:, :, 3] = 255
bg = Image.fromarray(bg_array, "RGBA")
bg.putalpha(mask)

# 3. Holographic Border
border_overlay = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw_border = ImageDraw.Draw(border_overlay)
draw_border.rounded_rectangle(
    [pad, pad, SIZE - pad, SIZE - pad],
    radius=radius,
    outline=(0, 242, 254, 180),
    width=3
)
# Inner glow border
draw_border.rounded_rectangle(
    [pad + 2, pad + 2, SIZE - pad - 2, SIZE - pad - 2],
    radius=radius - 2,
    outline=(121, 40, 202, 90),
    width=2
)

# 4. Wormhole Grid Horizon Lines
grid_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw_grid = ImageDraw.Draw(grid_layer)
for r_ring in [70, 120, 175]:
    draw_grid.ellipse(
        [CENTER - r_ring, CENTER - r_ring, CENTER + r_ring, CENTER + r_ring],
        outline=(255, 255, 255, 22),
        width=1
    )
draw_grid.line([CENTER - 180, CENTER, CENTER + 180, CENTER], fill=(255, 255, 255, 18), width=1)
draw_grid.line([CENTER, CENTER - 180, CENTER, CENTER + 180], fill=(255, 255, 255, 18), width=1)

# 5. Dual-Plane Wormhole Torus Spiral (Supersampled for silky smooth rendering)
SCALE = 2
SS_SIZE = SIZE * SCALE
SS_CENTER = SS_SIZE / 2
spiral_layer = Image.new("RGBA", (SS_SIZE, SS_SIZE), (0, 0, 0, 0))
draw_spiral = ImageDraw.Draw(spiral_layer)

def draw_wormhole_arm(start_angle, color_start, color_end, width_base):
    # Spiral trajectory connecting outer space horizon into singularity
    points = []
    colors = []
    num_steps = 380
    for i in range(num_steps):
        theta = start_angle + (i / num_steps) * 4.6
        # Radius decreases smoothly towards center
        progress = i / num_steps
        radius = (1.0 - 0.78 * (progress ** 0.85)) * (165 * SCALE)
        x = SS_CENTER + radius * math.cos(theta)
        y = SS_CENTER + radius * math.sin(theta)
        points.append((x, y))
        
        # Color interpolation
        cr = int(color_start[0] * (1 - progress) + color_end[0] * progress)
        cg = int(color_start[1] * (1 - progress) + color_end[1] * progress)
        cb = int(color_start[2] * (1 - progress) + color_end[2] * progress)
        ca = int(255 * (0.85 + 0.15 * math.sin(progress * math.pi)))
        colors.append((cr, cg, cb, ca))
        
    for i in range(len(points) - 1):
        p1 = points[i]
        p2 = points[i + 1]
        progress = i / len(points)
        w = max(4, int(width_base * (1.0 - 0.35 * progress)))
        draw_spiral.line([p1, p2], fill=colors[i], width=w)

# Arm A: Local Plane (Emerald to Electric Cyan)
draw_wormhole_arm(
    start_angle=0.2,
    color_start=(56, 239, 125),   # #38ef7d Emerald
    color_end=(0, 242, 254),      # #00f2fe Cyan
    width_base=34
)

# Arm B: Remote Plane (Plasma Magenta to Deep Violet)
draw_wormhole_arm(
    start_angle=math.pi + 0.2,
    color_start=(255, 0, 128),    # #ff0080 Magenta
    color_end=(121, 40, 202),     # #7928ca Violet
    width_base=34
)

# Downscale supersampled spiral with anti-aliasing
spiral_down = spiral_layer.resize((SIZE, SIZE), Image.Resampling.LANCZOS)

# Create Bloom / HyperGlow layer
glow_layer = spiral_down.filter(ImageFilter.GaussianBlur(radius=14))
glow_layer2 = spiral_down.filter(ImageFilter.GaussianBlur(radius=6))

# 6. Singularity Core (Gravitational Event Horizon)
core_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw_core = ImageDraw.Draw(core_layer)

# Radial core glow
for r_glow, alpha, color in [
    (56, 40, (0, 242, 254)),
    (42, 80, (121, 40, 202)),
    (30, 140, (165, 243, 252)),
    (18, 220, (255, 255, 255)),
    (10, 255, (255, 255, 255))
]:
    draw_core.ellipse(
        [CENTER - r_glow, CENTER - r_glow, CENTER + r_glow, CENTER + r_glow],
        fill=(color[0], color[1], color[2], alpha)
    )

core_bloom = core_layer.filter(ImageFilter.GaussianBlur(radius=8))

# 7. Quantum Data Packets / Photon Impulses
photon_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw_photons = ImageDraw.Draw(photon_layer)
photons = [
    (CENTER - 110, CENTER - 65, 6, (56, 239, 125, 255)),
    (CENTER + 110, CENTER + 65, 6, (0, 242, 254, 255)),
    (CENTER + 70, CENTER - 110, 6, (255, 0, 128, 255)),
    (CENTER - 70, CENTER + 110, 6, (168, 85, 247, 255)),
    (CENTER - 45, CENTER - 35, 4, (255, 255, 255, 255)),
    (CENTER + 45, CENTER + 35, 4, (255, 255, 255, 255)),
]
for px, py, pr, pcol in photons:
    draw_photons.ellipse([px - pr, py - pr, px + pr, py + pr], fill=pcol)

photon_bloom = photon_layer.filter(ImageFilter.GaussianBlur(radius=4))

# 8. Dimensional Convergence Diamond Core Star
star_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw_star = ImageDraw.Draw(star_layer)
star_pts = [
    (CENTER, CENTER - 22),
    (CENTER + 5, CENTER - 5),
    (CENTER + 22, CENTER),
    (CENTER + 5, CENTER + 5),
    (CENTER, CENTER + 22),
    (CENTER - 5, CENTER + 5),
    (CENTER - 22, CENTER),
    (CENTER - 5, CENTER - 5)
]
draw_star.polygon(star_pts, fill=(255, 255, 255, 240))
star_bloom = star_layer.filter(ImageFilter.GaussianBlur(radius=3))

# 9. Composite Layers in sequence
final = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
final.alpha_composite(bg)
final.alpha_composite(grid_layer)
final.alpha_composite(border_overlay)
final.alpha_composite(glow_layer)
final.alpha_composite(glow_layer2)
final.alpha_composite(spiral_down)
final.alpha_composite(core_bloom)
final.alpha_composite(core_layer)
final.alpha_composite(photon_bloom)
final.alpha_composite(photon_layer)
final.alpha_composite(star_bloom)
final.alpha_composite(star_layer)

# Apply squircle mask to the final composition to ensure perfect anti-aliased border clipping
final.putalpha(mask)

# Save high-res master PNG
final.save("resources/icon.png", format="PNG", optimize=True)
print("Successfully generated resources/icon.png (512x512 RGBA)")

