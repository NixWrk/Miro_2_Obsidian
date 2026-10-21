"""User-facing service errors must follow the selected desktop language."""

from miro2obsidian import gui_support
from miro2obsidian.desktop_strings import translate
from miro2obsidian.import_service import ImportResult


def test_revoked_connection_result_and_next_step_are_fully_russian():
    result = ImportResult(
        "needs_user", board_name="example", reason="not_connected",
        message="Miro rejected the saved connection (it was revoked or has expired).",
        next_step="Reconnect Miro: run `miro2obsidian auth login --form`.",
    )
    outcome = gui_support.outcome_from_import_result(result)
    original = "\n".join(gui_support.outcome_lines(outcome))
    text = translate(original, "ru")
    assert text == (
        "[Требуется ваше участие] example\n"
        "  Miro отклонил сохранённое подключение: доступ отозван или срок его действия истёк.\n"
        "  Что делать: Нажмите «Настроить приложение Miro» для первого подключения или «Сменить команду Miro» для повторного. "
        "Пройдите шаги подключения и снова нажмите «Экспортировать»."
    )
    assert translate(original, "en") == original
    event = {"event": "needs_user", **result.to_dict()}
    translated_event = translate(gui_support.format_import_event(event), "ru")
    assert "Miro rejected" not in translated_event
    assert "Click '" not in translated_event
    assert "Настроить приложение Miro" in translated_event


def test_localized_success_preserves_paths_and_board_names():
    result = ImportResult(
        "complete", board_name="Open file: Board", artifact_path="D:/Miro boards/one.json",
        source_json="D:/Miro boards/one.json", message="Imported 17 items into a JSON export.",
        next_step="Open D:/Miro boards to use the JSON and attachments.",
    )
    text = translate("\n".join(gui_support.outcome_lines(gui_support.outcome_from_import_result(result))), "ru")
    assert "[Готово] Open file: Board" in text
    assert "Сохранён экспорт JSON: элементов — 17." in text
    assert "D:/Miro boards/one.json" in text
    assert "Что делать: Откройте папку D:/Miro boards: в ней JSON и вложения." in text
