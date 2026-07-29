"""Founder/support tool for an org-wide key kill switch -- lists every
mcp_api_keys row (both cli and mcp) for one org, and optionally revokes
every one that isn't already revoked.

Talks to the database directly rather than through an HTTP endpoint:
mcp_api_keys is what issues per-org auth in the first place, so there's no
existing per-org auth boundary to hang a new admin HTTP surface off of
without inventing a whole separate founder-auth mechanism. This action is
rare, high-blast-radius (kills every live session and agent integration
for a real org in one shot), and already gated by whoever holds
DATABASE_URL -- a new authenticated endpoint would be more attack surface
for no real benefit over that.

Usage:
  uv run python scripts/revoke_org_keys.py <org_id>                    # list only, no changes
  uv run python scripts/revoke_org_keys.py <org_id> --revoke-all --yes # actually revoke everything active
"""

import argparse
import asyncio
import sys
from datetime import datetime, timezone

from sqlalchemy import select

from gnt.db.models import McpApiKey
from gnt.db.session import get_sessionmaker


async def _run(org_id: str, revoke_all: bool, confirmed: bool) -> None:
    session_factory = get_sessionmaker()
    async with session_factory() as session:
        rows = (
            await session.execute(
                select(McpApiKey)
                .where(McpApiKey.org_id == org_id)
                .order_by(McpApiKey.created_at.desc())
            )
        ).scalars().all()

        if not rows:
            print(f"no keys found for org {org_id}")
            return

        print(f"{len(rows)} key(s) for org {org_id}:")
        for key in rows:
            status = "revoked" if key.revoked_at else "active"
            admin = " admin" if key.is_admin else ""
            print(
                f"  {key.id}  {key.key_type:<3}{admin:<6}  {status:<8}  "
                f"{key.name or '(unnamed)'}  created {key.created_at.isoformat()}"
            )

        if not revoke_all:
            return

        active = [k for k in rows if k.revoked_at is None]
        if not active:
            print("\nnothing active to revoke")
            return

        if not confirmed:
            print(f"\n{len(active)} active key(s) would be revoked -- re-run with --yes to confirm")
            return

        now = datetime.now(timezone.utc)
        for key in active:
            key.revoked_at = now
        await session.commit()
        print(f"\nrevoked {len(active)} key(s) for org {org_id}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("org_id")
    parser.add_argument("--revoke-all", action="store_true", help="revoke every active key for this org")
    parser.add_argument("--yes", action="store_true", help="required alongside --revoke-all to actually commit")
    args = parser.parse_args()

    if args.revoke_all and not args.yes:
        print("--revoke-all without --yes is a dry run -- listing only.", file=sys.stderr)

    asyncio.run(_run(args.org_id, args.revoke_all, args.yes))


if __name__ == "__main__":
    main()
