# Automation branch UI changes / Изменения интерфейса ветки автоматизации

`automation-onboarding-52c0ec4.patch` preserves the setup, shared design,
localization, and guided workflow changes tested against automation commit
`52c0ec4` from `claude/magical-franklin-8q3t48`. These changes are separate from
the production backend in this branch. The patch includes the shared UI files
as well as the feature-specific setup wizard and SDK handoff presentation.

Apply only in a clean checkout of the specified base:

```powershell
git apply --check <path-to-patch>
git apply <path-to-patch>
```

The patch was checked against the Git index for `52c0ec4`. Shared desktop,
setup, and SDK checks passed on the patched feature snapshot. Real Miro export
acceptance remains pending; this patch does not merge or certify that backend.

Патч сохраняет изменения настройки, общего дизайна, русского и английского
языка и пошагового интерфейса, проверенные на коммите автоматизации `52c0ec4`.
Он включает общие файлы интерфейса, мастер настройки и интерфейс передачи SDK.
Применяйте его только в чистой копии указанного коммита, предварительно выполнив
`git apply --check`. Применимость проверена по индексу Git. Проверки интерфейса,
настройки и SDK прошли; приёмка реального экспорта из Miro остаётся открытой.
