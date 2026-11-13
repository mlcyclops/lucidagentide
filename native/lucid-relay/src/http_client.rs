// The one outbound HTTP(S) client the collab broker needs: Google's securetoken JWKS (the identity gate) and the
// metadata server plus Firestore REST (presence). rustls with the same AWS-LC provider as the listener and the
// webpki root set; plain http is allowed because the metadata server, a JWKS mirror or an emulator may be http.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use std::time::Duration;

pub struct HttpResponse {
    pub status: u16,
    pub headers: hyper::HeaderMap,
    pub body: Bytes,
}

impl HttpResponse {
    /// fetch's `res.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

#[derive(Clone)]
pub struct HttpClient {
    inner: Client<HttpsConnector<HttpConnector>, Full<Bytes>>,
}

impl HttpClient {
    pub fn new() -> Result<HttpClient, String> {
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(std::sync::Arc::new(crate::server::provider()))
            .map_err(|e| e.to_string())?
            .https_or_http()
            .enable_http1()
            .build();
        Ok(HttpClient { inner: Client::builder(TokioExecutor::new()).build(connector) })
    }

    /// One request, the whole reply read, everything bounded by `timeout`.
    pub async fn send(&self, method: &str, url: &str, headers: &[(&str, &str)], body: Vec<u8>, timeout: Duration) -> Result<HttpResponse, String> {
        let mut req = hyper::Request::builder().method(method).uri(url);
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let req = req.body(Full::new(Bytes::from(body))).map_err(|e| e.to_string())?;
        let work = async {
            let res = self.inner.request(req).await.map_err(|e| e.to_string())?;
            let status = res.status().as_u16();
            let headers = res.headers().clone();
            let body = res.into_body().collect().await.map_err(|e| e.to_string())?.to_bytes();
            Ok::<_, String>(HttpResponse { status, headers, body })
        };
        tokio::time::timeout(timeout, work).await.map_err(|_| "The operation was aborted.".to_string())?
    }
}
