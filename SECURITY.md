# Security policy

## Reporting a vulnerability

Please don't open a public issue for a security vulnerability. Use GitHub's private
vulnerability reporting instead: go to this repo's **Security** tab and click **Report a
vulnerability**. That opens a private advisory only maintainers can see, so we can fix the
issue before it's public.

We'll acknowledge a report as soon as we can and follow up with next steps once we've had a
chance to look at it. If it turns out to be a real, exploitable issue, we'll credit you in the
advisory when we publish it, unless you'd rather stay anonymous.

Please include:

- What the issue is and why it's exploitable.
- Steps to reproduce it, or a proof-of-concept request/payload.
- Which component it's in (`apps/api`, `apps/store`, `apps/web`, `apps/cli`) and whether it
  applies to the hosted service, self-hosting, or both.
- Impact as you see it: what an attacker gets (data exposure, privilege escalation, RCE, etc).

## Supported versions

This is a young project with no long-term-support branches. Security fixes go against `main`
and the latest release. If you're running an older version, update before reporting, or note
in your report that you can't.
