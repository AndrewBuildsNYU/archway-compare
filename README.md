# Archway Compare

One prompt, up to four models from different vendors, streaming side by side in the
browser. It demonstrates the thing the NYU Archway exists for: a single `sk-nyu-â€¦` key
that reaches every vendor NYU fronts, so comparing OpenAI against Anthropic against
anything else is one fetch loop and no second account.

## Try it

<https://andrewbuildsnyu.github.io/archway-compare/>

## Get a key

Issue one from the Archway portal, at `/portal` on the gateway.

Make a **low-quota key** for this. The page is a browser app, so the key lives in your
browser's `sessionStorage` and travels in a request header that anyone with your
laptop or your devtools can read. A key with a small token budget limits what a leak
costs you. The page never sends the key anywhere but the Archway.

## Run it locally

```
git clone https://github.com/AndrewBuildsNYU/archway-compare.git
cd archway-compare
```

Open `index.html`. That is the whole build: no bundler, no npm, no dependencies, no
server. Every call goes to the Archway from your browser.

Pointing it at a different Archway (the base URL field in the key panel) needs that
page's origin â€” including `null` for a `file://` page â€” in `NYU_CORS_ALLOWED_ORIGINS`
on that gateway. A missing origin fails as an opaque network error, because a blocked
CORS preflight and an unreachable host look identical to JavaScript.

## How it works

The interesting part is the fan-out in `assets/app.js`:

1. `Archway.listModels()` returns only the chat models **this key** may call, so the
   picker is already scoped to your permissions. `Archway.onePerProvider(models, 4)`
   picks the default set â€” one model per vendor, which is the comparison worth seeing.
2. `Promise.all` starts every selected model at once, each `Archway.streamChat()` call
   writing fragments into its own column with `textContent`. Model output is untrusted
   input; nothing here touches `innerHTML`.
3. Each column catches its own failures. A vendor being down, a model being
   unavailable, or a quota refusal renders inside that one column and the other
   streams keep going.
4. Each column's footer reads the `X-NYU-*` response headers: tokens the gateway
   counted, elapsed time, and a `mock` badge when the Archway had no active credential
   for that vendor and answered from its mock adapter â€” with real token accounting.
5. A single `AbortController` per column makes "Stop all" one loop over four signals.

When everything settles, a summary line names the fastest model and the one that spent
the fewest tokens. Tokens, not dollars, are what the Archway enforces.

## Files

| File | What it is |
| --- | --- |
| `index.html` | Page shell, the prompt form, the model picker, and this app's few layout rules |
| `assets/app.js` | The fan-out: picker state, concurrent streams, per-column rendering |
| `assets/archway.js` | Shared Archway client â€” key panel, models, chat, streaming, errors |
| `assets/archway.css` | Shared design system: tokens, components, dark mode |

The two shared `assets/archway.*` files are identical across every Archway example, so
a fix made in one place lands in all of them.

MIT licensed.
