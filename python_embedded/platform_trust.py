"""Platform-specific TLS initialization for backend entry points."""

import sys


def configure_platform_trust() -> None:
    """Install macOS system roots before dependencies can create HTTP clients."""
    if sys.platform == "darwin":
        import truststore

        truststore.inject_into_ssl()
