# Third-party notices

This repository is licensed under the [MIT License](LICENSE). It depends on or
interoperates with independently licensed projects; their licenses apply to
their own code and distributions.

## Python dependencies

| Project | Use | License |
|---|---|---|
| [CustomTkinter](https://github.com/TomSchimansky/CustomTkinter) | Desktop GUI | MIT; the PyPI metadata also carries a CC0 classifier |
| [Requests](https://github.com/psf/requests) | HTTP client | Apache-2.0 |
| [Pillow](https://github.com/python-pillow/Pillow) | Visual regression images | MIT-CMU |
| [Playwright for Python](https://github.com/microsoft/playwright-python) | Browser-based tests | Apache-2.0 |
| [pytest](https://github.com/pytest-dev/pytest) | Tests | MIT |
| [Ruff](https://github.com/astral-sh/ruff) | Linting | MIT |

These packages are installed from their normal package registries and are not
vendored in this repository. Their transitive dependencies retain their own
licenses.

## Optional integrations

- [JSON Canvas](https://github.com/obsidianmd/jsoncanvas) is an open format
  published under MIT.
- Playwright downloads a separate Chromium build for visual tests. Chromium is
  not stored in this repository and retains its upstream BSD-style and bundled
  third-party licenses.
- The Web SDK exporter loads Miro's hosted Web SDK at runtime. The SDK is not
  stored or relicensed here and remains subject to Miro's developer terms.
- [Advanced Canvas](https://github.com/Developer-Mike/obsidian-advanced-canvas)
  is an optional, separately installed Obsidian plugin licensed under GPL-3.0.
  This repository does not copy or modify its source code. The local installer
  downloads a release from its upstream repository at the user's request.
- Miro APIs, SDKs, services, names, and marks remain subject to Miro's terms
  and policies. This project does not include Miro's proprietary source code.

Miro and Obsidian are trademarks of their respective owners. This independent
project is not affiliated with, endorsed by, or sponsored by either company.
