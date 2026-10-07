"""Presentation policy for selecting live desktop export sources."""

from pathlib import Path

REST_AND_SDK = "REST + Web SDK (recommended)"
REST_ONLY = "REST only (less data)"
REST_COVERAGE = "REST: available text, sticky notes, shapes, frames, cards, app cards, connectors, images, documents and embeds, plus groups, tags and board metadata. Extra reads capture connector details, group members and tag assignments; experimental mode also reads mindmap nodes and their details. Available comments and attachments are fetched separately. Some images can be previews; some Miro documents become PDF/HTML."
SDK_COVERAGE = "Web SDK: supported board objects, groups and tags, plus explicit experimental shape/mindmap reads, layer indices and the exporting app's metadata where supported. It can add items or fill geometry, styling and other fields missing from REST. These sources overlap; SDK does not guarantee more data for every object. Its JSON alone does not replace REST comments or downloaded attachments."
UNION_COVERAGE = "REST + Web SDK: combines both sources without duplicating shared items; REST values take priority and Web SDK fills empty fields and adds its own items. This is the default. A verified whole-board Web SDK JSON is required; the program will not silently fall back to REST."
LIMITS = "Current limits: some tables, Kanban and unsupported widgets may expose only geometry. SDK metadata is limited to the exporting app; unavailable reads are recorded. Comment replies are checked against returned counts and continuation links; coverage of all resolved threads remains unverified. REST + Web SDK captures more sources, but is not proof of all public-API data."
OUTPUT_COVERAGE = "JSON preserves the captured source data and provenance. Canvas displays what its format and converter support; an item can remain in JSON even when it cannot be shown in Canvas."
BATCH_HELP = "The URL-list workflow currently supports REST only. For REST + Web SDK, export one board at a time with its own JSON, or explicitly choose REST only (less data)."
SDK_REQUIRED = "REST + Web SDK requires the downloaded whole-board JSON. Follow the instructions below and choose the file, or explicitly select REST only (less data)."


def websdk_selection_error(*, source_mode, workflow_mode, method, path, allow_missing_assets):
    """Reject implicit source loss before authentication or publication."""
    if source_mode == "Existing JSON" or workflow_mode == "Agent" or method == REST_ONLY:
        return ""
    if source_mode == "Miro URL list":
        return BATCH_HELP
    if not path:
        return SDK_REQUIRED
    if not Path(path).is_file():
        return "Choose an existing whole-board Web SDK JSON file."
    if allow_missing_assets:
        return "REST + Web SDK requires complete attachments. Turn off Allow missing assets (degraded), or choose REST only (less data)."
    return ""
