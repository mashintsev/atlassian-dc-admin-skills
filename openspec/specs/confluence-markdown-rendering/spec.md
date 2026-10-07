# confluence-markdown-rendering Specification

## Purpose

Defines how Confluence storage format becomes Markdown when pages, versions and comments are read, so the text is faithful and carries no avoidable tokens.

## Requirements

### Requirement: Tables render their own rows once
A table SHALL be rendered from its own rows only, including rows inside its `thead`, `tbody` and `tfoot`. Rows of a table nested in a cell SHALL appear only inside that cell, flattened to text, and SHALL NOT be repeated as rows of the outer table.

#### Scenario: Nested table
- **WHEN** a page has a 3-row table whose second row holds a 4-row table in one cell
- **THEN** the Markdown table has 3 rows and the inner table's text appears once, inside its cell

### Requirement: Same-instance links and images are short and round-trip
- **Attachment images** (`ri:attachment`) on the page itself SHALL render as `![alt](<filename>)`: the bare filename, which the Markdown write path already turns back into an attachment image. They SHALL NOT render as an absolute download URL, which the write path turns into an external image.
- **Links to the same instance:** the base URL SHALL be removed, leaving the relative path.
- **External links** SHALL keep their URL.
- **Read results:** a page or version read SHALL state once that bare image names are attachments of that page, downloadable with `confluence_download_content_attachments`.

#### Scenario: Diagram on a page
- **WHEN** a page embeds `diagram.png` from its own attachments
- **THEN** the Markdown shows `![](diagram.png)` without the base URL or page id

#### Scenario: Read, edit, write back
- **WHEN** an agent reads that page as Markdown, edits a paragraph and writes the Markdown back
- **THEN** the image is stored again as an attachment image of `diagram.png`, not as an external URL image

### Requirement: Comments are converted from storage
`confluence_get_comments` and `confluence_get_inline_comments` SHALL convert the comment's storage body with the same rules as page bodies. They SHALL NOT use the rendered view HTML.

In compact lists, each comment body SHALL be cut to the cell limit. In JSON, each body SHALL be cut at `max_body_chars`: default 2,000, maximum 20,000.

#### Scenario: Comment with a mention and a macro
- **WHEN** a comment holds a user mention and a status macro
- **THEN** the Markdown has the mention as `@username` and the status text, without rendered HTML attributes or icon URLs

### Requirement: Macros keep meaning without markup
- Macros without a body that carry meaning SHALL render as a short marker with their main parameter, for example `[status: DONE]`, `[include: Page title]` and `[toc]`.
- Unknown macros SHALL keep their body text and their name as a marker.
- Code macros SHALL keep their code. A code block longer than 200 lines in a read SHALL be cut, with the lines left out and a hint to use `body_format=storage` or `section`.

#### Scenario: Status macro
- **WHEN** a page contains a status macro with title DONE
- **THEN** the Markdown shows `[status: DONE]`

### Requirement: Truncated code cannot be published as Markdown
Page creation, update and section update SHALL reject Markdown containing the read code-cut marker before making any request. Storage input SHALL remain supported for complete code.

#### Scenario: Writing back a cut code block
- **WHEN** an agent submits Markdown copied from a read with a cut code block
- **THEN** the write fails with ValidationError and a hint to read complete storage or narrow the section
- **AND** no request is sent
