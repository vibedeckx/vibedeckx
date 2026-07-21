# Session Expiry Alert Width Design

## Context

The session-expiry alert currently fills the authentication wrapper's `max-w-md` width, while Clerk's sign-in card is narrower. Shortening the message reduces wrapping but cannot change a block element's width by itself.

## Design

- Shorten the message to `Session expired. Sign in again to continue.`
- Give both the alert and Clerk `rootBox` the same responsive width constraint: `w-full max-w-[400px]`.
- Center both elements with `mx-auto` so their left and right edges align.
- Preserve full-width behavior below 400px for small screens.
- Do not change the alert color, icon, spacing, or session-expiry behavior.

## Testing

Extend the authentication component test to verify that the expiry alert uses the shortened copy and that the alert and mocked Clerk root share the same width classes.

