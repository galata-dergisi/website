"""Shared packaged-scan hooks for externally deployed magazine payloads."""

MEDIA_EXCLUSIONS = (
    r"^https?://[^/]+(?::[0-9]+)?/images/sayi[0-9]+(?:/|$)",
    r"^https?://[^/]+(?::[0-9]+)?/magazines/sayi[0-9]+/audio(?:/|$)",
)


def zap_started(zap, target):
    """Install exclusions before the packaged scripts access or spider target."""
    del target
    for expression in MEDIA_EXCLUSIONS:
        zap.spider.exclude_from_scan(expression)
        zap.ascan.exclude_from_scan(expression)
