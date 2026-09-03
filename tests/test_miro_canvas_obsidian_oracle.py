from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from tools.obsidian_oracle import compatibility
from tools.obsidian_oracle import install_miro_canvas_runtime as installer
from tools.obsidian_oracle import profile as profile_tools
from tools.obsidian_oracle import stage_compatibility_fixture as staging


def _config(vault: Path) -> dict[str, object]:
    return {
        "vault_path": str(vault),
        "work_folder": "MIRO2OBSIDIAN",
        "oracle_subfolder": "_oracle",
        "required_plugins": {"advanced-canvas": "6.0.1", "miro-canvas": "0.1.0"},
    }


def _make_vault(vault: Path) -> None:
    (vault / ".obsidian" / "plugins").mkdir(parents=True)
    (vault / ".obsidian" / "community-plugins.json").write_text(
        '["advanced-canvas"]\n', encoding="utf-8"
    )


def _make_runtime(source: Path, *, text: str = "new") -> None:
    source.mkdir(parents=True)
    (source / "manifest.json").write_text(
        json.dumps({"id": "miro-canvas", "version": "0.1.0"}),
        encoding="utf-8",
    )
    (source / "main.js").write_text(f"// {text}\n", encoding="utf-8")
    (source / "styles.css").write_text(f"/* {text} */\n", encoding="utf-8")


def test_committed_matrix_has_four_offline_profiles_and_expected_documents() -> None:
    profiles = compatibility.load_compatibility_matrix()

    assert [profile.id for profile in profiles] == [
        "native-only",
        "miro-canvas-only",
        "advanced-only",
        "both",
    ]
    assert len(profiles) == 4
    for profile in profiles:
        document = compatibility.load_profile_document(profile)
        assert isinstance(document["nodes"], list)
        assert isinstance(document["edges"], list)
        assert ("miroCanvas" in document) is profile.miro_canvas


def test_profile_lookup_rejects_unknown_profile_without_filesystem_mutation() -> None:
    with pytest.raises(ValueError, match="Unknown compatibility profile"):
        compatibility.get_profile("not-a-profile")


def test_oracle_path_guard_rejects_a_vault_outside_configured_target(tmp_path: Path) -> None:
    configured = tmp_path / "configured"
    other = tmp_path / "other"
    with pytest.raises(ValueError, match="exactly the configured project-local vault"):
        installer.require_oracle_vault(other, _config(configured))


def test_local_runtime_install_copies_only_release_assets_and_enables_plugin(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    source = tmp_path / "built" / "miro-canvas"
    _make_vault(vault)
    _make_runtime(source)
    (source / "src-secret.txt").write_text("must not be copied", encoding="utf-8")

    with patch.object(installer, "load_config", return_value=_config(vault)):
        target = installer.install_miro_canvas_runtime(source_plugin_dir=source)

    assert target == vault / ".obsidian" / "plugins" / "miro-canvas"
    assert (target / "main.js").read_text(encoding="utf-8") == "// new\n"
    assert not (target / "src-secret.txt").exists()
    enabled = json.loads(
        (vault / ".obsidian" / "community-plugins.json").read_text(encoding="utf-8")
    )
    assert enabled == ["advanced-canvas", "miro-canvas"]


def test_runtime_install_rolls_back_runtime_and_enabled_list_when_settings_write_fails(
    tmp_path: Path,
) -> None:
    vault = tmp_path / "oracle"
    source = tmp_path / "built" / "miro-canvas"
    _make_vault(vault)
    _make_runtime(source, text="new")
    old_target = vault / ".obsidian" / "plugins" / "miro-canvas"
    _make_runtime(old_target, text="old")
    enabled_path = vault / ".obsidian" / "community-plugins.json"
    before_enabled = enabled_path.read_bytes()

    with (
        patch.object(installer, "load_config", return_value=_config(vault)),
        patch.object(installer, "_atomic_write_enabled", side_effect=OSError("simulated settings failure")),
        pytest.raises(OSError, match="simulated settings failure"),
    ):
        installer.install_miro_canvas_runtime(source_plugin_dir=source)

    assert (old_target / "main.js").read_text(encoding="utf-8") == "// old\n"
    assert enabled_path.read_bytes() == before_enabled


def test_runtime_install_refuses_missing_build_artifacts_before_touching_vault(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    source = tmp_path / "built" / "miro-canvas"
    _make_vault(vault)
    source.mkdir(parents=True)
    (source / "manifest.json").write_text(
        '{"id":"miro-canvas","version":"0.1.0"}', encoding="utf-8"
    )

    with patch.object(installer, "load_config", return_value=_config(vault)):
        with pytest.raises(RuntimeError, match="main.js"):
            installer.install_miro_canvas_runtime(source_plugin_dir=source)

    assert not (vault / ".obsidian" / "plugins" / "miro-canvas").exists()


def test_stage_all_profiles_is_atomic_and_stays_below_oracle_vault(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    _make_vault(vault)
    config = _config(vault)

    with patch.object(staging, "load_config", return_value=config):
        staged = staging.stage_all_profiles()

    assert [path.name for path in staged] == [
        "native-only.canvas",
        "miro-canvas-only.canvas",
        "advanced-only.canvas",
        "both.canvas",
    ]
    staging_root = vault / "MIRO2OBSIDIAN" / "_oracle" / "m0-compatibility"
    assert all(path.parent == staging_root for path in staged)
    assert (staging_root / "compatibility_matrix.json").is_file()
    assert all(path.resolve().is_relative_to(vault.resolve()) for path in staged)


@pytest.mark.parametrize(
    ("profile_id", "expected_plugins"),
    [
        ("native-only", []),
        ("miro-canvas-only", ["miro-canvas"]),
        ("advanced-only", ["advanced-canvas"]),
        ("both", ["advanced-canvas", "miro-canvas"]),
    ],
)
def test_activate_and_check_each_profile_sets_only_its_controlled_plugins(
    tmp_path: Path,
    profile_id: str,
    expected_plugins: list[str],
) -> None:
    vault = tmp_path / "oracle"
    _make_vault(vault)
    config = _config(vault)

    with (
        patch.object(profile_tools, "load_config", return_value=config),
        patch.object(staging, "load_config", return_value=config),
    ):
        activated = profile_tools.activate_profile(profile_id)
        checked = profile_tools.check_profile(profile_id)

    assert list(activated.enabled_plugins_after) == expected_plugins
    assert list(checked.enabled_plugins) == expected_plugins
    assert checked.profile.id == profile_id
    assert checked.canvas_path.is_file()


def test_profile_activation_preserves_only_explicit_safe_unrelated_entries(
    tmp_path: Path,
) -> None:
    vault = tmp_path / "oracle"
    _make_vault(vault)
    enabled_path = vault / ".obsidian" / "community-plugins.json"
    enabled_path.write_text('["safe-plugin", "other-plugin"]\n', encoding="utf-8")
    config = _config(vault)

    with (
        patch.object(profile_tools, "load_config", return_value=config),
        patch.object(staging, "load_config", return_value=config),
    ):
        activated = profile_tools.activate_profile(
            "native-only", preserve_plugin_ids=("safe-plugin",)
        )
        checked = profile_tools.check_profile(
            "native-only", preserve_plugin_ids=("safe-plugin",)
        )

    assert list(activated.enabled_plugins_after) == ["safe-plugin"]
    assert list(checked.enabled_plugins) == ["safe-plugin"]
    with (
        patch.object(profile_tools, "load_config", return_value=config),
        patch.object(staging, "load_config", return_value=config),
        pytest.raises(RuntimeError, match="unapproved unrelated"),
    ):
        profile_tools.check_profile("native-only")

    with pytest.raises(ValueError, match="Unsafe unrelated plugin ID"):
        profile_tools._normalise_preserved_plugin_ids(("../outside",))
    with pytest.raises(ValueError, match="Controlled plugin ID"):
        profile_tools._normalise_preserved_plugin_ids(("miro-canvas",))


def test_profile_activation_rolls_back_canvas_and_enabled_plugins_on_write_failure(
    tmp_path: Path,
) -> None:
    vault = tmp_path / "oracle"
    _make_vault(vault)
    config = _config(vault)
    staging_root = vault / "MIRO2OBSIDIAN" / "_oracle" / "m0-compatibility"
    staging_root.mkdir(parents=True)
    canvas_target = staging_root / "both.canvas"
    old_canvas = b'{"nodes": [], "edges": [], "old": true}\n'
    canvas_target.write_bytes(old_canvas)
    enabled_path = vault / ".obsidian" / "community-plugins.json"
    before_enabled = enabled_path.read_bytes()

    with (
        patch.object(profile_tools, "load_config", return_value=config),
        patch.object(staging, "load_config", return_value=config),
        patch.object(
            profile_tools,
            "_atomic_write_enabled",
            side_effect=OSError("simulated profile settings failure"),
        ),
        pytest.raises(OSError, match="simulated profile settings failure"),
    ):
        profile_tools.activate_profile("both")

    assert enabled_path.read_bytes() == before_enabled
    assert canvas_target.read_bytes() == old_canvas


def test_profile_runtime_check_is_separate_from_enabled_state(tmp_path: Path) -> None:
    vault = tmp_path / "oracle"
    _make_vault(vault)
    config = _config(vault)

    with (
        patch.object(profile_tools, "load_config", return_value=config),
        patch.object(staging, "load_config", return_value=config),
    ):
        profile_tools.activate_profile("native-only")
        checked = profile_tools.check_profile("native-only", require_runtime=True)

    assert checked.runtime_missing == ()
