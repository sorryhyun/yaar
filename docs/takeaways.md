# Takeaways from GPT-5.3-Instant System Prompt (2026-03-04)

Analysis of OpenAI's latest production system prompt for agentic patterns, tool design,
UI enrichment, and prompt engineering techniques applicable to YAAR.

## Table of Contents

1. [Tool Description Engineering](#1-tool-description-engineering)
2. [Compact Tool Call Format](#2-compact-tool-call-format)
3. [Content References & Entity System](#3-content-references--entity-system)
4. [Citation & Source Attribution](#4-citation--source-attribution)
5. [Image Enrichment with Guardrails](#5-image-enrichment-with-guardrails)
6. [GenUI Widget Library](#6-genui-widget-library)
7. [Writing Blocks](#7-writing-blocks)
8. [Personalization Framework](#8-personalization-framework)
9. [Automations & Scheduling](#9-automations--scheduling)
10. [Product & Business Verticals](#10-product--business-verticals)
11. [Safety Boundaries in Tool Specs](#11-safety-boundaries-in-tool-specs)
12. [Prompt Style & Behavioral Rules](#12-prompt-style--behavioral-rules)
13. [Multi-Channel Output Routing](#13-multi-channel-output-routing)
14. [Applicability to YAAR](#14-applicability-to-yaar)

---

## 1. Tool Description Engineering

The single biggest difference between GPT-5.3's tool specs and typical MCP tool descriptions
is **depth**. The `web` tool description alone is ~350 lines. It's structured as a mini-manual.

### Pattern: When-to / When-not-to Sections

GPT groups tool usage guidance into explicit trigger and anti-trigger sections:

```
<situations_where_you_must_use_web>
You MUST maximally use the web tool. You MUST call the web tool whenever the response
could benefit from web information, even if just to double check things. The only
exception is when it's 100% certain that the web tool will not be helpful.
</situations_where_you_must_use_web>

<situations_where_you_must_not_use_web>
You should NOT call this tool when web information would not help:
- Greetings, pleasantries, and other casual chatting.
- Non-informational requests.
- Creative writing when no references are required.
- Requests to rewrite, summarize, or translate text that is already provided.
- Questions about yourself, your own opinions, or purely internal analysis.
</situations_where_you_must_not_use_web>
```

This is notably more effective than just describing what a tool does. It directly shapes the
model's decision boundary for tool invocation.

### Pattern: Cost/Latency Awareness

The web tool has two search backends with explicit cost guidance:

```
You can retrieve web search results from two search engines:
- slow: maps to system1_search_query. Slow costs much more.
  Use as a backup when you are sure fast can not give you the results you need.
- fast: maps to system2_search_query. Fast costs less,
  and should be your primary choice when possible.
```

And operational rules around mixing them:

```
You can use slow and fast in different search turns, e.g. start with fast
and switch to slow if needed. But do not use them both in the same turn.
When using fast, you can use more queries in one call.
You should be more conservative with the number of queries when using slow.
```

This is a form of **resource-aware prompting** — the model is taught to optimize its own
tool usage costs. YAAR could apply this to distinguish lightweight verbs (read, list) from
expensive ones (invoke with side effects, WebSearch).

### Pattern: Concrete Examples for Every Command

Every tool variant gets at least one example, often several:

```
product|plain cotton white shirts
product|blue jeans for men|Levi's Men's 511 Slim Fit Jeans
business|San Francisco, CA, USA|Best Rated Indian Restaurants;Top Indian Restaurants|Tony's Pizza
business|user|coffee shop    (if user asks "coffee near me")
image|orange cats|365
image|datacenters in texas|365|reuters.com;techcrunch.com
```

This is more effective than schema-only descriptions because it teaches the model the
**idiomatic usage pattern**, not just the valid syntax.

### Pattern: Recency Guidance

Time-sensitivity is handled with explicit recency tiers:

```
For time-sensitive or recent-event queries, include "recency" in at least one search:
- Use recency=1 for breaking or "today" queries.
- Use recency=7 for "this week" or recent developments.
- Use recency=30 for "this month" or broader freshness windows.

If the returned sources are stale, undated, or do not match the requested
time window, run another search with tighter recency before finalizing.
```

This teaches the model a **retry strategy** when results are stale, rather than just accepting
whatever comes back.

---

## 2. Compact Tool Call Format

GPT's `web` tool uses a **pipe-delimited text format** instead of JSON:

```
// ToolCallCompactV1 payload (UTF-8 text). Input must be ONE STRING (NOT JSON).
// DO NOT surround your output in ANY json syntax, including braces.
//
// Format:
// Newline-separated records; each record is one action.
// Record syntax: <op>|<field1>|<field2>|...  (fields separated by literal '|')
// Records separated by literal newline. No {}, [], or quotes.
```

### Multi-command batching in a single tool call

```
fast|golden state warriors news
fast|golden state warriors season analysis 2025
genui_run|nba_schedule_widget|{"fn":"schedule", "team":"GSW", "num_games":10}
```

Three independent queries in one tool call. This is significantly more token-efficient than
three separate JSON tool calls with full schema overhead.

### Escaping rules

```
Escaping (inside any field; backslash):
  \|  literal '|'
  \;  literal ';'
  \\  literal '\'
  \n  embedded newline
  \t  tab (optional)

Lists inside a field:
  List-of-strings fields are encoded as a single field with items separated by ';'.
  If an item contains ';', escape it as \;
```

### Why this matters

Standard JSON tool calls have significant overhead:
- `{"uri": "yaar://windows/my-win", "payload": {"action": "update", "operation": "append", "content": "..."}}`
- vs `invoke|yaar://windows/my-win|update|append|...`

For high-frequency tools (window updates, search), this overhead compounds. The compact
format also enables batching multiple operations in a single tool call, reducing round trips.

### Trade-off

Compact format reduces token cost but increases parsing complexity and makes the tool harder
to use correctly. GPT mitigates this with extensive examples and escaping docs. Worth
measuring whether YAAR's verb call volume justifies this optimization.

---

## 3. Content References & Entity System

GPT has a **structured entity reference system** that turns names in responses into
interactive UI elements. This is one of the most interesting patterns for YAAR.

### Format

Content references use PUA (Private Use Area) Unicode characters as delimiters:

```
[U+E200]<key>[U+E202]<specification>[U+E201]
```

Two main types:

**Entity references** — clickable names that open info panels:

```
[U+E200]entity[U+E202]["restaurant","Cotogna","San Francisco, CA, USA | 490 Pacific Ave"][U+E201]
[U+E200]entity[U+E202]["movie","The Shawshank Redemption","1994 film"][U+E201]
[U+E200]entity[U+E202]["musical_artist","Taylor Swift"][U+E201]
```

**Image groups** — inline visual enrichment:

```
[U+E200]image_group[U+E202]{"layout": "carousel", "query": ["orange tabby cat", "persian cat"]}[U+E201]
[U+E200]image_group[U+E202]{"layout": "bento", "query": ["Golden State Warriors team photo", "Stephen Curry portrait"]}[U+E201]
```

### Entity Types (30+)

```
musical_artist, athlete, politician, fictional_character, known_celebrity, people
local_business, restaurant, hotel
city, state, country, point_of_interest, place
company, organization
event, holiday, festival, historical_event
mobile_app, software, vehicle, medication, brand
artwork, movie, book, tv_show, song, album, video_game
food, animal, stock, cryptocurrency
sports_team, sports_event, sports_league
transport_system, exercise, academic_field, scientific_concept, disease
```

### Disambiguation Rules

Location-tied entities use structured disambiguation:

```
[U+E200]entity[U+E202]["local_business","Four Barrel Coffee","San Francisco, CA, USA | 375 Valencia St"][U+E201]
```

Others use contextual disambiguation strings:

```
[U+E200]entity[U+E202]["movie","Avatar","2009 James Cameron film"][U+E201]
```

### Usage Rules

```
- ALWAYS use entity references in informational, explorative, answer seeking,
  recommendation, list, or planning queries.
- NEVER use entity references for: General chit-chat/jokes/creative writing,
  writing tasks, inside code blocks or software engineering questions.
- Entities are extremely valuable, and should be used whenever possible to
  highlight things that the user might want to explore more.
```

### Key insight

This system separates **content** (what the AI says) from **interactivity** (what the user
can click on). The entity is embedded inline in the text — it's both readable as plain text
AND interactive. The AI doesn't need to create a separate UI element; the entity enrichment
happens at the rendering layer.

---

## 4. Citation & Source Attribution

GPT has a formal, mandatory citation system for web-sourced information.

### Reference ID System

Every source returned by the web tool gets a unique ID based on type and position:

```
Image sources:   【turn0image3】
Product sources: 【turn0product1】
Business sources:【turn0business8】
Video sources:   【turn0video1】
News sources:    【turn0news1】
Reddit sources:  【turn0reddit2】
Search sources:  【turn0search5】
```

### Citation Format

```
To cite a single reference ID (e.g. turn3search4):
  citeturn3search4

To cite multiple reference IDs:
  citeturn3search4turn1news0

Always place webpage citations at the very end of the paragraphs, list item,
or table cells they support.
```

### Link Format

```
When writing a URL from web/product/business source:
  link_title<anchor text><reference ID>

Never directly write any URLs or markdown links "[label](url)";
always use the source's reference ID.
```

### Copyright Limits

```
- Quotes: ≤10 words for lyrics; ≤25 words from any single non-lyrical source.
- Per-source paraphrase cap: respect [wordlim N] (default 200 words/source).
- Don't reproduce full articles/long passages; use brief quotes + paraphrase.
- Exception: these caps do not apply to reddit.com.
```

### Freshness Verification

```
For time-sensitive answers, include at least one normal citation from a source
with an explicit recent publication date that matches the user-requested time window.
Prefer high-authority, highly relevant, and fresher sources if available.
Do not rely only on evergreen/background pages for recent-news claims.
```

### Key insight

The citation system serves three purposes:
1. **Trust** — users can verify claims
2. **Copyright compliance** — word limits prevent reproduction
3. **Source quality** — freshness and authority requirements push the model toward better sources

---

## 5. Image Enrichment with Guardrails

GPT has a detailed framework for when to include inline images vs when not to.

### High-Value Use Cases

```
- Explaining processes
- Browsing and inspiration
- Exploratory context
- Highlighting differences
- Quick visual grounding
- Visual comprehension
- Introduce People / Place
```

### Low-Value / Incorrect Use Cases

```
- UI walkthroughs without exact, current screenshots
- Precise comparisons
- Speculation, spoilers, or guesswork
- Mathematical accuracy
- Casual chit-chat & emotional support
- Other More Helpful Artifacts (Python/Search/Image_Gen)
- Writing / coding / data analysis tasks
- Pure Linguistic Tasks: Definitions, grammar, and translation
- Diagram that needs Accuracy
```

### Multiple Image Groups

```
In longer, multi-section answers, you can use more than one image group,
but space them at major section breaks and keep each tightly scoped:
- Compare-and-contrast across categories
- Timeline or era segmentation
- Geographic or regional breakdowns
- Ingredient → steps → finished result
```

### Bento Layout

```
Use image group with bento layout at the top to highlight entities,
when user asks about single entity, e.g., person, place, sport team.
```

### Key insight

The value of this isn't the image system itself — it's the **decision framework**. GPT
doesn't just give the model an image tool; it gives it a rubric for when images help vs
hurt. This reduces noise and keeps responses focused.

---

## 6. GenUI Widget Library

GPT has a **searchable widget catalog** for structured interactive UI.

### Two-Step Flow

1. `genui_search|weather` — find relevant widgets by category/keywords
2. `genui_run|weather_widget_with_source|{"location":"San Francisco"}` — render the widget

### Key Rules

```
- genui_search queries must use categories/keywords, not proper nouns.
  Translate names into categories when searching widgets.
  (e.g. "carlos alcaraz" → genui_search|tennis)

- If genui_search returns multiple widgets, select the single most relevant widget.

- The genui_run args MUST use the exact widget name and argument shape
  returned by genui_search. Do NOT invent widget names or args.

- Widgets are supplemental rich UI. Your text response must still stand on
  its own and include key details.
```

### Parallel Execution

```
If the widget response also needs fresh web information, the first genui call
MUST be in parallel with fast or slow. For widgets that don't need web info
(calculator, timer, unit conversion) call genui_search/genui_run alone.
```

### Prefetched Widgets

```
If relevant prefetched widget results are already present in context,
you may skip genui_search and go straight to genui_run.
```

### Key insight

This is essentially a **component marketplace** where the model discovers and instantiates
UI components by category. The search-then-run pattern prevents the model from hallucinating
widget names while keeping the system extensible. The "text must stand alone" rule ensures
widgets enhance rather than replace the response.

---

## 7. Writing Blocks

GPT has a fenced block syntax for structured content types.

### Format

```
:::writing{variant="email" id="12345" subject="Q3 Review" recipient="team@co.com"}
Dear team,

Here are the Q3 results...
:::
```

### Variants

```
variant: "email" | "chat_message" | "social_post" | "standard"
```

### Metadata

```
- variant: required, defaults to "standard"
- id: 5-digit string, required, unique
- subject: required if variant="email"; forbidden otherwise
- recipient: allowed only if variant="email" AND user provided an email
```

### Scope Limitation

Only used for: email, chat messages (SMS, Slack), social media posts. Not for general
writing, code, or documents (those go to Canvas).

### Key insight

Writing blocks are a lighter alternative to Canvas (their equivalent of YAAR windows) for
short, structured content. The variant system means the UI can render email drafts differently
from Slack messages differently from tweets — same tool, different presentation. This is
similar to YAAR's renderer concept but applied to inline content.

---

## 8. Personalization Framework

GPT injects structured user context into every conversation.

### Three Context Sections

```
1. User Knowledge Memories:
   Insights from previous interactions — user details, preferences, interests,
   ongoing projects, relevant factual information.

2. Recent Conversation Content:
   Summaries of recent interactions — ongoing themes, current interests,
   relevant queries to the present conversation.

3. Model Set Context:
   Specific insights captured throughout conversation history —
   notable personal details or key contextual points.
```

### Personalization Rules

```
- Personalize whenever clearly relevant and beneficial.
- NEVER ask questions for information already present in the provided context.
- Personalization should be contextually justified and natural.
- Always prioritize correctness and clarity.
```

### Penalty Clause

```
Significant penalties apply to unnecessary questions, failure to use
context correctly, or any irrelevant personalization.
```

### Safety Boundaries on Personal Data

```
NEVER use any user information that could be used to identify the user
(e.g. ID or account numbers), or are personal secrets (e.g. password,
security questions), or are otherwise sensitive, including: health and
medical conditions, race, ethnicity, religion, association with political
parties, trade union membership, sexual orientation, sex life, criminal history.
```

### Key insight

The three-tier memory structure (knowledge, recent, model-set) is more sophisticated than
a flat memory store. "Recent conversation content" is particularly interesting — it's not
the raw conversation but a summary, meaning there's an intermediate summarization step that
compresses past interactions into reusable context. The "never ask what you know" rule with
penalties is a strong behavioral constraint that YAAR's memorize system lacks.

---

## 9. Automations & Scheduling

GPT has a full scheduling system using iCal VEVENT format.

### Tool Interface

```typescript
type create = (_: {
  prompt: string,          // Message sent when automation fires
  title: string,           // Short, imperative, verb-first. No dates.
  schedule?: string,       // iCal VEVENT format
  dtstart_offset_json?: string,  // relativedelta args for DTSTART
}) => any;
```

### Schedule Examples

```
Every morning:
  BEGIN:VEVENT
  RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0
  END:VEVENT

In 15 minutes:
  schedule=""
  dtstart_offset_json='{"minutes":15}'
```

### Behavioral Rules

```
- Lean toward NOT suggesting tasks. Only offer to remind if you're sure it'd help.
- Give SHORT confirmations: "Got it! I'll remind you in an hour."
- DO NOT refer to tasks as a feature separate from yourself.
  Say "I'll notify you" not "I've created an automation."
- When error is "Too many active automations," suggest deleting one.
```

### Key insight

The prompt field is designed as **deferred user message** — "written as if it were a message
from the user to you." This means the automation re-enters the conversation as a natural
follow-up, not a system event. The title rules (imperative, no dates, verb-first) ensure
the automation list reads cleanly. The behavioral rules around self-reference ("I'll remind
you" not "I've created an automation") maintain the agent illusion.

---

## 10. Product & Business Verticals

GPT has specialized search verticals with custom UI rendering.

### Product System

```
product|<search?>|<lookup?>

Treat a request as shopping and call product whenever the user is choosing,
evaluating, or planning to buy physical goods purchasable online.

High-recall rule: If uncertain whether a query is "shopping" vs "research",
choose the higher-recall path — call product_query and surface product UI.
```

### Product Carousels

```
products{"selections":[["turn0product1","Product Title"],["turn0product2","Product Title"]]}

Use a product carousel when multiple products or variants could satisfy the request.
Do not use a carousel for narrow comparison between a small, fixed set of products.
When distinct categories or scenarios are involved, use multiple carousels.
```

### Business System

```
business|<location?>|<query?>|<lookup?>|<lat?>|<long?>|<lat_span?>|<long_span?>

When the user queries entities around them ("near me", "nearby", "close by"),
you MUST ALWAYS set location as "user" and NEVER use coarse-grained location.
```

### Reddit Integration

```
Sources from reddit.com must be used and cited when the user is asking for
community reactions, reviews, recommendations, trends, experience sharing,
and general internet discussions.

Long quotes from reddit are allowed, as long as you indicate they are
direct quotes via markdown blockquote starting with ">", copy verbatim,
and cite the source.
```

### Key insight

The vertical-specific search + UI pattern is interesting. Instead of one generic search
tool, GPT has specialized verticals (web, product, business, image) each with their own
result format and rendering rules. The "high-recall rule" for products is notable — when
in doubt, show products. This bias toward action over caution is a deliberate UX choice.

---

## 11. Safety Boundaries in Tool Specs

GPT embeds detailed safety rules directly in tool descriptions, not just the system prompt.

### Prohibited Product Categories

```
- Firearms & parts (guns, ammunition, accessories, silencers)
- Explosives (fireworks, dynamite, grenades)
- Regulated weapons (tactical knives, switchblades, swords, tasers)
- Hazardous Chemicals & Toxins (pesticides, poisons, CBRN precursors)
- Self-Harm (diet pills, burning tools)
- Electronic surveillance, spyware
- Terrorist/Extremist Merchandise
- Adult sex products (except condom, lubricant)
- Prescription medication (except OTC)
- Alcohol, Nicotine, Recreational drugs
- Gambling devices
- Counterfeit/stolen goods, wildlife contraband
```

### Image Restrictions

```
DO NOT use image command or image group for:
- Low-value/invalid visuals: stock/watermarked, duplicates, outdated product shots
- Mismatched tasks: UI walkthroughs w/o current screenshots; exact specs
- Risky/unsuitable: safety, high-stakes, privacy, speculation, user-supplied image
```

### Copyright Enforcement

```
- If you derived any information from a webpage source, you MUST cite it.
  Do NOT miss any citations — otherwise it would result in copyright violations.
- Quotes: ≤10 words for lyrics; ≤25 words from any single non-lyrical source.
- Per-source paraphrase cap: respect [wordlim N] (default 200 words/source).
```

### Key insight

Safety boundaries are tool-scoped, not global. Each tool has its own prohibition list
relevant to its domain. This is more precise than a single global safety policy because
it contextualizes restrictions where the model actually makes decisions.

---

## 12. Prompt Style & Behavioral Rules

Several interesting micro-patterns in how GPT's behavior is shaped.

### Anti-Patronizing

```
Represent OpenAI and its values by avoiding patronizing language.
Do not use phrases like 'let's pause,' 'let's take a breath,'
or 'let's take a step back,' as these will alienate users.
Do not use language like 'it's not your fault' or 'you're not broken'
unless the context explicitly demands it.
```

### Emoji Usage

```
You must use several emojis in your response.
Avoid using the same emoji more than a few times in your response.
```

(Contrast with YAAR/Claude Code: "Only use emojis if the user explicitly requests it.")

### Follow-up Questions

```
Ask follow-up questions only when appropriate.
```

### Ad Handling

A detailed policy for handling platform ads that appear alongside responses. The model is
taught to:
- Never claim it inserted or controls ads
- Direct users to UI controls (hide, report, settings)
- Explain that ads don't influence responses
- State that conversations are private from advertisers

### Tool Name Privacy

```
You should never expose the internal tool names or tool call details
in your final response to the user.
```

### Key insight

The anti-patronizing rule is particularly interesting. LLMs naturally tend toward
"therapeutic" language ("let's take a step back", "that's a great question"). Explicitly
banning these phrases produces more direct, professional responses. The ad handling policy
is a masterclass in defensive prompt engineering — anticipating every possible user question
about a sensitive feature and providing scripted responses.

---

## 13. Multi-Channel Output Routing

GPT routes tool calls to different **channels** that control visibility.

### Channels

```
python        → analysis channel (private, user cannot see code or output)
python_user_visible → commentary channel (user sees code AND output)
canmore       → commentary channel (canvas creation/editing)
automations   → commentary channel
web           → analysis channel
```

### Key Rules

```
python must ONLY be called in the analysis channel, to ensure code is NOT visible.
python_user_visible must ONLY be called in the commentary channel, or else the
user will not be able to see the code OR outputs!
```

### Key insight

This is a deliberate separation of **internal reasoning** from **user-facing output**.
The model can run Python for its own analysis (data processing, image analysis) without
showing the user implementation details. But when the user asks for code or visualizations,
it uses a different tool that renders to the user.

YAAR has a similar concept: plain text responses are invisible, only windows and notifications
reach the user. But GPT's channel system is more granular — it applies per-tool rather than
per-output-type.

---

## 14. Applicability to YAAR

### High Priority (low effort, high impact)

| Idea | How it applies to YAAR |
|------|----------------------|
| **When-to / When-not-to guidance** | Add explicit trigger/anti-trigger sections to system prompt for each verb. "Don't invoke without reading the skill first." "Don't open a window for simple acknowledgments." "Prefer read over list+read when you know the URI." |
| **Cost/latency hints** | Mark verbs as lightweight (read, list, describe) vs heavyweight (invoke with side effects, WebSearch). Guide the model to prefer lightweight verbs when possible. |
| **Concrete examples per namespace** | The URI namespace table lists namespaces but gives minimal examples. Add 2-3 idiomatic usage examples per namespace showing the most common patterns. |
| **"Text must stand alone" rule** | When windows contain WebSearch results, the window content should be self-contained. If the window is closed, the information shouldn't be lost. |

### Medium Priority (moderate effort)

| Idea | How it applies to YAAR |
|------|----------------------|
| **Inline entity references** | Detect `yaar://` URIs in markdown window content and render as clickable chips. Clicking opens describe/read in a popover. Zero AI-side changes needed — pure frontend. |
| **Component presets** | Ship a `yaar://skills/components` catalog of pre-built templates (data card, stat grid, timeline, form). Model discovers via list, instantiates with data. Reduces token cost of component DSL. |
| **Citation system for WebSearch** | Tag WebSearch results with reference IDs. Define a citation format for markdown windows (e.g., `[^src1]` footnotes). Add a "Sources" footer to windows with web-sourced content. |
| **Structured memory categories** | Replace flat `memorize` text with categories: `preferences`, `facts`, `project_context`. Inject relevant categories at session start based on the first message. |
| **Retry strategies** | Teach the model what to do when tools return unexpected results: "If WebSearch results are stale, retry with tighter recency. If http fails, fall back to browser." (Partially exists but could be more explicit.) |

### Low Priority (high effort or speculative)

| Idea | How it applies to YAAR |
|------|----------------------|
| **Compact verb format** | Pipe-delimited shorthand for high-frequency verbs. Measure token costs first — may not be worth the parsing complexity given YAAR's lower call volume vs GPT's web tool. |
| **Automations namespace** | `yaar://automations/` with cron-like scheduling. Natural extension of hooks system. Needs a scheduler component (cron or setTimeout-based). |
| **Vertical-specific search** | Specialized search modes for products, businesses, images vs generic WebSearch. Only relevant if YAAR becomes a consumer-facing product. |
| **Analysis channel separation** | Allow the AI to run sandbox code privately (for reasoning) vs user-visibly. Currently all sandbox output is visible. Could be useful for data processing tasks where the user only wants results, not implementation. |

### Anti-Patterns to Avoid

| GPT Pattern | Why YAAR should skip it |
|-------------|------------------------|
| **Emoji mandate** ("You must use several emojis") | YAAR's developer-focused audience prefers clean, minimal output. Current "no emoji unless asked" policy is better. |
| **Ad handling policy** | Not applicable to YAAR. |
| **Penalty clause language** | "Significant penalties apply" is cargo-cult prompting. Behavioral rules work better stated as direct instructions. |
| **PUA Unicode delimiters** | Brittle encoding. YAAR's approach of explicit tool calls (invoke for windows, notifications for alerts) is more robust than embedding UI commands in text output. |
| **Extreme tool description length** | GPT's 350-line web tool description works because it's one mega-tool doing everything. YAAR's 5 generic verbs are simpler by design — the complexity lives in URI handlers, not tool descriptions. Don't bloat verb descriptions; put guidance in the system prompt instead. |
