# GoatX402 Demo

## Notes

- The demo backend calls `goatx402-core` through `goatx402-sdk-server`. Authentication headers (`X-Nonce`, `X-Timestamp`, and `X-Sign`) are generated and signed by the SDK, so application code does not need to construct them manually.
