This fixture protects CONV-040: the REST downloader can save a `doc_format`
attachment as HTML when PDF generation is unavailable. The converter must use
the downloaded `local_name` as-is when it already has an extension, instead of
blindly appending `.pdf` and creating a missing file reference.
