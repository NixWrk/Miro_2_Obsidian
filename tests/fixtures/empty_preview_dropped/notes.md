# Empty Preview Dropped

Unsupported Miro preview objects can arrive without title, description, url, or app fields.
The converter must not emit a zero-content text node because it creates invisible geometry that can overlap real content.
