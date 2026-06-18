Problem: `CONV-055` - empty Miro flowchart shapes were converted with synthetic subtype labels such as `predefined process`.

Expected: preserve the Canvas shape and styling, but do not invent visible text when Miro does not expose any text content. Shapes with explicit Miro content still keep that content.
