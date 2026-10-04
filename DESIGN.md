---
version: alpha
name: Connect Design System
description: Lightweight social UI system for Connect, balancing X-style density, Threads-style conversation, Instagram media polish, and Discord-like presence. Direct messaging and hashtag-trend surfaces are retired; legacy references below are historical only.
colors:
  primary: "#2563eb"
  secondary: "#64748b"
  tertiary: "#7c3aed"
  neutral: "#eef2f7"
  surface: "#ffffff"
  on-surface: "#0f172a"
  muted: "#94a3b8"
  border: "rgba(15, 23, 42, 0.08)"
  error: "#dc2626"
  success: "#166534"
  warning: "#92400e"
typography:
  headline-lg:
    fontFamily: Noto Sans JP
    fontSize: 28px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: 0px
  headline-md:
    fontFamily: Noto Sans JP
    fontSize: 22px
    fontWeight: 800
    lineHeight: 1.3
    letterSpacing: 0px
  body-md:
    fontFamily: Noto Sans JP
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0px
  body-sm:
    fontFamily: Noto Sans JP
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0px
  label-md:
    fontFamily: Noto Sans JP
    fontSize: 13px
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: 0px
rounded:
  sm: 10px
  md: 16px
  lg: 20px
  xl: 24px
  full: 999px
spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  xxl: 32px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.full}"
    padding: 12px
  button-secondary:
    backgroundColor: "#f8fafc"
    textColor: "{colors.secondary}"
    rounded: "{rounded.full}"
    padding: 12px
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.md}"
    padding: 16px
  input:
    backgroundColor: "#f8fafc"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.sm}"
    padding: 12px
  badge:
    backgroundColor: "#eff6ff"
    textColor: "{colors.primary}"
    rounded: "{rounded.full}"
    padding: 8px
  app-canvas:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.on-surface}"
  metadata:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  destructive-action:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.error}"
    rounded: "{rounded.full}"
    padding: 12px
  success-badge:
    backgroundColor: "#dcfce7"
    textColor: "{colors.success}"
    rounded: "{rounded.full}"
    padding: 8px
  warning-badge:
    backgroundColor: "#fef3c7"
    textColor: "{colors.warning}"
    rounded: "{rounded.full}"
    padding: 8px
---

# Connect Design System

## Overview

Connect is a lightweight social app. The UI should feel like a practical middle point between X, Threads, Instagram and Discord: dense enough to browse quickly, calm enough for conversation, and polished enough for image/video posts.

The product should feel modern, readable, and socially alive. Avoid large decorative gradients, vague icon-only controls, inconsistent card spacing, and student-project style one-off styling.

## Colors

The palette uses cool neutral surfaces with one blue-to-purple accent.

- **Primary (#2563eb):** main action, selected navigation, active tabs, links and focused states.
- **Secondary (#64748b):** usernames, timestamps, helper text and metadata.
- **Tertiary (#7c3aed):** paired with primary only for the Connect gradient accent.
- **Neutral (#eef2f7):** app canvas behind white cards.
- **Surface (#ffffff):** post cards, lists, settings sections, profile panels and modals.
- **Error (#dc2626):** destructive actions only.

## Typography

Use Noto Sans JP throughout. The app should not feel like a marketing landing page; post text and conversations are the core. Keep letter spacing at `0px`. Use weight and spacing for hierarchy, not oversized type.

- **headline-lg:** page titles and profile names.
- **headline-md:** modal titles and section headers.
- **body-md:** posts, comments and descriptions; legacy DM text is not a current UI surface.
- **body-sm:** supporting labels and secondary text.
- **label-md:** buttons, tabs, badges and compact controls.

## Layout

Use a 4px-based spacing scale. Feed-like screens should stay readable at a max width around 640px. The persistent five-tab bottom navigation remains visible on mobile, tablet and desktop.

- `xs` is for icon/text gaps.
- `sm` is for compact control gaps.
- `md` is for row-level grouping.
- `lg` is the default card padding.
- `xl` separates panels.
- `xxl` is reserved for larger page rhythm.

## Elevation & Depth

Depth is subtle. Repeated cards use borders plus soft shadows. Floating surfaces such as modals, call panels and post composer overlays can use stronger shadows. Avoid heavy, dark card shadows on normal feed items.

## Shapes

Cards use `rounded.md`. Inputs and media use `rounded.sm`. Large profile/modals can use `rounded.lg` or `rounded.xl`. Buttons, tabs, badges and navigation active states use `rounded.full`.

## Components

### Header

Sticky, compact, translucent and readable. Header actions should look like coherent controls, not unrelated icon chips.

### Bottom Navigation

The five navigation tabs are persistent across mobile, tablet and desktop. Active state must be visible through color, weight and a soft background, not color alone.

### Post Card

Post cards use a consistent surface, border, radius and shadow. Author row, body, media and action row should be visually distinct. Public visibility badges are hidden in feed cards and shown on detail pages.
Content with explicit `contentType` metadata is grouped as user content, news, advertising, or system imagery. Sponsored flags always render an `広告 / PR` badge. Untagged legacy posts remain user content; the UI does not guess a category from image appearance or body wording.

### Composer

The composer should feel light. Empty composer states stay compact; full post creation can expand into a focused composer. Upload and error states use inline feedback.

### Buttons

Primary buttons use the primary gradient. Secondary buttons are surface buttons with a border. Destructive buttons use danger color and require confirmation where applicable.

### Inputs

Inputs use a soft background, visible border and clear focus ring. Textareas should avoid unnecessary scrollbars and preserve typed content.
Search placeholders end with one Japanese ellipsis character (`…`, U+2026) throughout the app.

### Tabs and Badges

Tabs use compact segmented controls. Badges are small, high-signal labels. Avoid repeating obvious labels such as "全体公開" in dense feed cards.

### Empty States

Empty states should be compact and actionable. Use one icon, one clear line, and one optional action.

## Do's and Don'ts

Do keep feed density high enough that posts appear quickly after opening home.
Do use `primary` and the gradient only for active or primary actions.
Do keep profile, friends, notifications and settings surfaces visually consistent.
Do preserve existing Firebase, routing, auth, post, notification, and QR behavior. DM routes/data remain only as explicitly documented legacy compatibility paths.

Don't add decorative blobs, oversized cards or unrelated color palettes.
Don't use one-off margins, radii or shadows when an existing token fits.
Don't hide focus states or reduce tap targets below comfortable mobile use.
Don't let bottom navigation cover the last content item.


