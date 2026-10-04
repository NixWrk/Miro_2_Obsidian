from html.parser import HTMLParser

from miro2obsidian.app_setup import MIRO_APPS_URL, setup_intro_html


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.links.append(dict(attrs))


def test_setup_uses_account_independent_miro_settings_link():
    parser = Links()
    parser.feed(setup_intro_html())
    assert parser.links == [{
        "href": MIRO_APPS_URL,
        "target": "_blank",
        "rel": "noopener noreferrer",
    }]
    assert MIRO_APPS_URL == "https://miro.com/app/settings/user-profile/apps/"


def test_token_guidance_matches_the_version_capability():
    assert "does not renew" in setup_intro_html()
    assert "unchecked" in setup_intro_html()
    assert "can renew" in setup_intro_html(refresh_supported=True)
    assert "unchecked" not in setup_intro_html(refresh_supported=True)
