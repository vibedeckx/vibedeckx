# Authentication Back Link Design

## Context

The sign-in screen serves two entry paths:

- A signed-out visitor deliberately opens sign-in from the landing page.
- An active user's Clerk session expires and the app sends them directly to sign-in so they can recover the current workspace.

The existing `Back` button appears above the centered Clerk card in both paths. In the expiry path it offers an unhelpful escape to the landing page. In the deliberate sign-in path its isolated top-left placement creates a visually unbalanced pseudo-header.

## Design

- When `sessionExpired` is true, do not render a back control. The expiry notice and sign-in form remain the only actions, keeping recovery focused.
- For deliberate sign-in, render a centered secondary text-style control below the Clerk card with the label `← Back to home`.
- Activating that control returns to the existing landing-page state. It does not navigate browser history or alter the preserved workspace URL.
- Keep the existing Clerk form, expiry notice, and authentication state flow unchanged.

## Testing

Add focused component coverage for the two states:

- Deliberate sign-in shows `Back to home` below the sign-in form and returns to the landing page when activated.
- Session-expiry sign-in shows the expiry notice and does not expose `Back to home`.

