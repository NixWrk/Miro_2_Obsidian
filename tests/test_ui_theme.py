import pytest

from miro2obsidian.ui_theme import COLORS, DARK_COLORS


def luminance(color):
    channels = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in channels]
    return sum(v * weight for v, weight in zip(linear, (.2126, .7152, .0722)))


@pytest.mark.parametrize("palette", [COLORS, DARK_COLORS], ids=["light", "dark"])
@pytest.mark.parametrize("foreground,background", [
    ("ink", "surface"), ("muted", "surface"), ("purple", "surface"),
    ("note_ink", "purple_soft"), ("#ffffff", "button"),
])
def test_theme_text_contrast(palette, foreground, background):
    values = [luminance(palette.get(key, key)) for key in (foreground, background)]
    assert (max(values) + .05) / (min(values) + .05) >= 4.5
