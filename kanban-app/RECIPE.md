# Kanban

A Herdr app layout where each agent is a card in a status column: Idle, Needs you, Working, Done. The person can hide any column. A panel at the right shows the terminal of the selected agent.

![Kanban](layouts/kanban.svg)

## What you see

Left to right, top to bottom (zoom 1):

- **Sidebar**, 240 px, `chrome` background: the shipped `workspace-chrome` brand (46 px), the shipped `spaces` list, the `workspace-chrome` footer (69 px).
- **Top bar**, 52 px, `chrome` background, 1 px bottom border, `window_drag`. From the left: an accent tile with a board icon; the title "Agents" (14 px semibold) over the count ("5 agents", 11 px; amber with "· 2 need you" when an agent is blocked); a switch Board / Terminals (32 px high, pill, active item raised); a search box 220 px wide; 4 column chips; a layers button; a panel button; a "back" button with the name of the previous layout and a swap icon; a primary "New agent" button; window buttons when `window().buttons`.
- **Board**, `canvas` background, 12 px padding and gap. 4 columns of equal width (min 236 px), in this order: Idle, Needs you, Working, Done. A column is a 16 px rounded box with a 1 px border and a background tinted 5% with its status color (`theme().idle`, `blocked`, `working`, `done`). Header 48 px: a 26 px tile with an icon (moon, bell, zap, check), the name (13 px semibold), a count badge, an eye-off button.
- **Card**, `background` color, 12 px radius, 1 px border, 12 px padding, 9 px gap: a program tile (28 px, from `program.tile` and `program.icon`), the program name, the space name, a status mark at the right; the terminal title (12 px, 2 lines max); pills for the Git branch (mono), the folder and a named tab; a footer with the age and 2 icon buttons (pin, open).
- **Terminal panel**, 460 px (min 280, max 1100), `background` color, 14 px radius, `md` shadow: `{ "agent": "focused" }`.
- **Status bar**, 28 px, the shipped `workspace-status`.

## How it behaves

- Status to column: `idle` to Idle, `blocked` to Needs you, `working` to Working, `done` to Done. Inside a column: pinned first, then the highest `seq` first.
- **working**: a 2 px line on top of the card pulses (`loop opacity 0.2 to 1, 1400 ms`) and a spinner turns (`spin 900`). **blocked**: the bell pulses (`0.3 to 1, 1100 ms`), the border is amber, the column tile pulses. **done**: a check. **idle**: a moon.
- A column chip toggles the column. Hidden: dim, the name is struck, the dot is hollow. The list of hidden ids is `shared("kanban.hidden")`. With all 4 hidden the board shows a message and a "Show all columns" button.
- The search box filters on title, program, space, tab and branch (`shared("kanban.query")`). The layers button limits the cards to the active space (`shared("kanban.scope")`: `all` or `space`).
- Click a card: `agent.focus {terminal}`; `layout.show {id:"detail"}` when the panel is hidden. The pin button runs `terminal.pin {terminal, pinned}`. The open button runs `space.select`, `tab.select`, `pane.focus` and `layout.select {stack:"view", child:"tabs-view"}`.
- The switch runs `layout.select {stack:"view", child:"board-view" | "tabs-view"}`. In Terminals view the top bar shows the tab pills of the active space and a `+` that runs `tab.new`.
- The back button first runs `setShared("layout.previous", shared("layout"))`, then `layout.switch {name}`. Its target is, in order: `shared("layout.previous")`, `props.back` (of the `bar` block), `main`, the first other name of `layouts()`; it never is the shown layout. It is hidden when no other layout exists.
- The panel button runs `layout.toggle {id:"detail"}`. "New agent" opens the shipped `new-menu` as a popup (250 x 512).
- The board calls `setAgentOrder` with the visible cards, so `agent.next` and `agent.prev` follow the board.

## Built from

- `layouts/kanban.json`: root `row` (`titlebar: none`, `background: canvas`): `sidebar` (column) and `work` (column). `work` holds blocks `bar` and `status`, and a `stack` `view` (active `board-view`) with the `row` `board-view` (blocks `board` and `detail`) and the block `tabs-view` (`{ "tab": "active", "pane": {...header: mod "pane"} }`, padding 12).
- `mods/kanban/main.js`: one `View`; `props.part` is `bar` or `board`; `props.lang` is `en` or `pt`. `mods/kanban/ui.js`: the icon button, the column chip, the switch, the search box, the pill and the button.
- `mods/kanban/*.svg`: 24 px stroke icons (`currentColor`), `spinner.svg`, and the 4 `win-*.svg` window icons.
- `herdr` functions: `agents`, `spaces`, `panes`, `focused`, `layout`, `window`, `theme`, `props`, `shared`, `setShared`, `run`, `openOverlay`, `setAgentOrder`.

## Watch out

- Write `mod.json` (`{ "place": "none" }`) before `main.js`. Without it Herdr docks a stray copy of the mod into the layout.
- Colors given to `bg` and `border_color` must be `#rrggbb[aa]`. Theme names do not work in a mod. Add alpha with a 2-digit hex suffix.
- A column needs `h_full()`. Without it the columns collapse to the header height and sit in the middle of the board.
- There is no `line_clamp`: the title uses `max_h(34).overflow_hidden()` for 2 lines.
- `props()` inside a later callback can answer for another copy: read the props once in `init(given, cx)`.
- The card age comes from the tab (`changed_at`, `working_since`), not from the agent.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/kanban` passes and `herdr-app status` shows no errors after `layout.switch {name: "kanban"}`.
- Each agent shows as one card, in the column of its status, with its program icon.
- Clicking a column chip hides and shows that column, and the choice stays after a restart.
- Clicking a card shows its terminal in the right panel.
- The Board / Terminals switch changes the view and the tab pills work.
