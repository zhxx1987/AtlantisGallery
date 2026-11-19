"""Optional standalone Gallery MCP; managed Atlantis clients bundle the same core."""
from pathlib import Path
import sys

from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import StrictBool

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from publisher.core import GitHub, REPO, PAGES, prepare_gallery_upload, publish_gallery_asset, sync_social

mcp = FastMCP('Atlantis Gallery')
from publisher.requirements_guide import read_gallery_requirements
mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True))(read_gallery_requirements)
mcp.tool(annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True))(prepare_gallery_upload)

@mcp.tool(name='publish_gallery_asset', annotations=ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=True))
def publish_gallery_asset_tool(manifest_path: str, approval_digest: str, requirements_digest: str, confirm_public: StrictBool = False) -> dict:
    """Publish only the exact reviewed public plan. Creator repositories host preview and downloads."""
    return publish_gallery_asset(manifest_path, approval_digest, requirements_digest, confirm_public)

if __name__ == '__main__':
    if sys.argv[1:] == ['--sync-social']:
        updated = sync_social(GitHub(), Path(__file__).resolve().parent.parent, REPO, PAGES)
        print('Updated social.json.' if updated else 'All Gallery assets already have social links.')
    else:
        mcp.run(transport='stdio')
