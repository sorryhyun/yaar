# Mascot

A tiny SD chick character that lives on the desktop in a frameless, transparent widget
window. It wanders around on its own by moving its own window, can be grabbed and dragged
with the pointer (it flails while held and gets dizzy when released), and reacts when its
window is moved by someone else.

## What you can do

- `walk_to { x, y }` — send the mascot walking to a desktop position (top-left of its window).
- `say { text }` — show a short speech bubble (max 40 chars) above the character.
- Read the `mascot` state for its current mood (`idle | walk | held | dizzy`), facing
  direction, and position.

## Notes

- The window is 150×190, frameless, transparent, `variant: widget`. Do not resize it.
- The app moves its own window via `invoke('yaar://windows/{id}', { action: 'move' })`;
  motion between hops is smoothed by the `windowStyle` CSS transition in `app.json`.
- Don't relocate the mascot's window yourself with the move action unless asked — use
  `walk_to` so the walking animation plays.
