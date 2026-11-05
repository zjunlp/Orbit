FROM python:3.11-slim@sha256:e88e9763f943ec1834f992a4b51e0f24500486803e8bc534e5767af9ea65f6ce

# Only local multi-turn environments and checkers are used; model clients are unnecessary.
RUN pip install --no-cache-dir --no-deps mpmath==1.3.0 \
    'https://files.pythonhosted.org/packages/ba/41/ed458527c770c50225b60bae3b0c3444b26804ee455fa2d8f187018d2cb2/bfcl_eval-2026.3.23-py3-none-any.whl#sha256=3bb6dfa5f0c68ad403c9ec50b00db2bb3b4cc9b38ab1ff33f48fe30d853d3a0a'
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONHASHSEED=0 TZ=UTC
