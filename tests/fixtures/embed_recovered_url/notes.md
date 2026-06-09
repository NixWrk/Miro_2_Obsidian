# Embed Recovered URL

Miro can export Embedly iframe objects with an empty `data.url` field.
The converter should recover the canonical URL from the iframe query instead of dropping the embed.
