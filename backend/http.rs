use crate::service::{ServiceError, SkillsService};
use axum::{
    Extension, Json, Router,
    body::{Body, to_bytes},
    extract::{Path, Query, Request, State},
    http::{HeaderValue, Method, StatusCode, Uri, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};
use tower_http::services::{ServeDir, ServeFile};

const BODY_LIMIT: usize = 16 * 1024;

impl IntoResponse for ServiceError {
    fn into_response(self) -> Response {
        let status = StatusCode::from_u16(self.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, Json(json!({ "error": self.message }))).into_response()
    }
}

fn error(status: u16, message: &str) -> Response {
    (
        StatusCode::from_u16(status).unwrap(),
        Json(json!({ "error": message })),
    )
        .into_response()
}

fn local_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ["localhost", "127.0.0.1", "[::1]"].iter().any(|name| {
        host == *name
            || host.strip_prefix(&format!("{name}:")).is_some_and(|port| {
                !port.is_empty()
                    && port.len() <= 5
                    && port.bytes().all(|byte| byte.is_ascii_digit())
            })
    })
}

async fn protect_local_access(mut request: Request, next: Next) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let api = request.uri().path() == "/api" || request.uri().path().starts_with("/api/");
    let rejection = if !local_host(host) {
        Some(error(
            403,
            "Use localhost or 127.0.0.1 to connect to this service.",
        ))
    } else if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) {
        let origin_valid = request.headers().get(header::ORIGIN).is_none_or(|value| {
            value
                .to_str()
                .ok()
                .and_then(|origin| origin.parse::<Uri>().ok())
                .is_some_and(|origin| {
                    origin.scheme_str() == Some("http")
                        && origin
                            .authority()
                            .is_some_and(|authority| authority.as_str() == host)
                })
        });
        if !origin_valid {
            Some(error(403, "Requests must come from this service origin."))
        } else if request
            .headers()
            .get("sec-fetch-site")
            .is_some_and(|value| value == "cross-site")
        {
            Some(error(403, "Cross-site requests are not allowed."))
        } else if !request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
        {
            Some(error(415, "API changes require application/json."))
        } else {
            None
        }
    } else {
        None
    };
    let mut response = if let Some(rejection) = rejection {
        rejection
    } else if api
        && request
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value
                    .split(';')
                    .next()
                    .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json"))
            })
    {
        let (mut parts, body) = request.into_parts();
        match to_bytes(body, BODY_LIMIT).await {
            Ok(bytes) => {
                let parsed = if bytes.is_empty() {
                    Ok(json!({}))
                } else {
                    serde_json::from_slice::<Value>(&bytes)
                };
                match parsed {
                    Ok(value) if value.is_object() || value.is_array() => {
                        parts.extensions.insert(value);
                        request = Request::from_parts(parts, Body::empty());
                        next.run(request).await
                    }
                    _ => error(400, "Invalid JSON request."),
                }
            }
            Err(_) => error(413, "The request exceeds the size limit."),
        }
    } else {
        next.run(request).await
    };
    if api
        && !response
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|value| {
                value
                    .to_str()
                    .is_ok_and(|value| value.starts_with("application/json"))
            })
    {
        let status = response.status();
        response = error(
            status.as_u16(),
            if status == StatusCode::BAD_REQUEST {
                "Invalid request path."
            } else {
                "API endpoint not found."
            },
        );
    }
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    response
        .headers_mut()
        .insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    if api {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

async fn blocking<T: serde::Serialize + Send + 'static>(
    work: impl FnOnce() -> Result<T, ServiceError> + Send + 'static,
) -> Response {
    match tokio::task::spawn_blocking(work).await {
        Ok(Ok(result)) => Json(result).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(error) => {
            eprintln!("ZSkills request failed: {error}");
            self::error(
                500,
                "The host could not complete this request. Rescan or check the service logs.",
            )
        }
    }
}

async fn workspace(State(service): State<SkillsService>) -> Response {
    blocking(move || Ok(service.workspace())).await
}
async fn rescan(State(service): State<SkillsService>) -> Response {
    blocking(move || Ok(service.start_scan())).await
}
async fn skill(State(service): State<SkillsService>, Path(id): Path<String>) -> Response {
    blocking(move || service.get_skill(&id)).await
}
async fn file(
    State(service): State<SkillsService>,
    Path(id): Path<String>,
    query: Result<Query<HashMap<String, String>>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let path = query
        .ok()
        .and_then(|Query(query)| query.get("path").cloned());
    let Some(path) = path else {
        return error(400, "Choose a file path.");
    };
    blocking(move || service.get_file(&id, &path)).await
}
async fn add_root(
    State(service): State<SkillsService>,
    Extension(body): Extension<Value>,
) -> Response {
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    blocking(move || service.add_root(&path)).await
}
async fn remove_root(State(service): State<SkillsService>, Path(id): Path<String>) -> Response {
    blocking(move || service.remove_root(&id)).await
}
async fn set_editor(
    State(service): State<SkillsService>,
    Extension(body): Extension<Value>,
) -> Response {
    let editor = body
        .get("editor")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    blocking(move || service.set_editor(&editor)).await
}
async fn open_editor(
    State(service): State<SkillsService>,
    Path(id): Path<String>,
    Extension(body): Extension<Value>,
) -> Response {
    let scope = body
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let path = body.get("path").and_then(Value::as_str).map(str::to_owned);
    blocking(move || service.open_editor(&id, &scope, path.as_deref())).await
}
async fn api_not_found() -> Response {
    error(404, "API endpoint not found.")
}

pub fn create_app(service: SkillsService, client_root: impl Into<PathBuf>) -> Router {
    let client_root = client_root.into();
    let api = Router::new()
        .route("/workspace", get(workspace))
        .route("/rescan", post(rescan))
        .route("/skills/{id}", get(skill))
        .route("/skills/{id}/file", get(file))
        .route("/skills/{id}/open", post(open_editor))
        .route("/roots", post(add_root))
        .route("/roots/{id}", axum::routing::delete(remove_root))
        .route("/editor", put(set_editor))
        .fallback(api_not_found)
        .method_not_allowed_fallback(api_not_found);
    Router::new()
        .nest("/api", api)
        .fallback_service(
            ServeDir::new(&client_root).fallback(ServeFile::new(client_root.join("index.html"))),
        )
        .layer(middleware::from_fn(protect_local_access))
        .with_state(service)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::ServiceOptions;
    use http_body_util::BodyExt;
    use std::{fs, time::Duration};
    use tempfile::{TempDir, tempdir};
    use tower::ServiceExt;

    struct Fixture {
        directory: TempDir,
        service: SkillsService,
        app: Router,
    }
    impl Fixture {
        fn new() -> Self {
            let directory = tempdir().unwrap();
            let home = directory.path().join("home");
            let client = directory.path().join("client");
            fs::create_dir_all(home.join("repo/.agents/skills/example")).unwrap();
            fs::create_dir_all(&client).unwrap();
            fs::write(
                home.join("repo/.agents/skills/example/SKILL.md"),
                "---\nname: Example\ndescription: Read a fixture safely\n---\n# Example\n",
            )
            .unwrap();
            fs::write(
                client.join("index.html"),
                "<!doctype html><title>ZSkills fixture</title>",
            )
            .unwrap();
            fs::write(client.join("asset.js"), "window.fixture = true;").unwrap();
            let service = SkillsService::new(ServiceOptions {
                home_dir: home,
                config_dir: directory.path().join("config"),
                roots: None,
            })
            .unwrap();
            let app = create_app(service.clone(), client);
            Self {
                directory,
                service,
                app,
            }
        }
        async fn request(
            &self,
            method: Method,
            uri: &str,
            body: &str,
            headers: &[(&str, &str)],
        ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
            let mut request = axum::http::Request::builder()
                .method(method)
                .uri(uri)
                .header(header::HOST, "127.0.0.1:4173");
            for (name, value) in headers {
                request = request.header(*name, *value);
            }
            let response = self
                .app
                .clone()
                .oneshot(request.body(Body::from(body.to_owned())).unwrap())
                .await
                .unwrap();
            let (parts, body) = response.into_parts();
            (
                parts.status,
                parts.headers,
                body.collect().await.unwrap().to_bytes().to_vec(),
            )
        }
        async fn json(&self, method: Method, uri: &str, body: Value) -> (StatusCode, Value) {
            let (status, _, bytes) = self
                .request(
                    method,
                    uri,
                    &body.to_string(),
                    &[
                        ("content-type", "application/json"),
                        ("origin", "http://127.0.0.1:4173"),
                    ],
                )
                .await;
            (status, serde_json::from_slice(&bytes).unwrap())
        }
        async fn scanned(&self) -> Value {
            for _ in 0..200 {
                let (status, _, bytes) = self.request(Method::GET, "/api/workspace", "", &[]).await;
                assert_eq!(status, StatusCode::OK);
                let workspace: Value = serde_json::from_slice(&bytes).unwrap();
                if workspace["scanning"] == false {
                    return workspace;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("Fixture scan did not complete");
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            self.service.dispose();
        }
    }

    #[tokio::test]
    async fn workspace_rescan_and_preview_preserve_the_browser_contract() {
        let fixture = Fixture::new();
        let workspace = fixture.scanned().await;
        assert_eq!(workspace["skills"].as_array().unwrap().len(), 1);
        assert_eq!(workspace["scanProgress"]["phase"], "complete");
        assert!(workspace["host"]["homeDir"].is_string());
        let id = workspace["skills"][0]["id"].as_str().unwrap();
        let (status, detail) = fixture
            .json(Method::GET, &format!("/api/skills/{id}"), json!({}))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(detail["skill"]["name"], "Example");
        let (status, file) = fixture
            .json(
                Method::GET,
                &format!("/api/skills/{id}/file?path=SKILL.md"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert!(file["content"].as_str().unwrap().contains("# Example"));
        assert!(file["modifiedAt"].is_string());
        let (status, _) = fixture
            .json(Method::GET, &format!("/api/skills/{id}/file"), json!({}))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = fixture
            .json(
                Method::GET,
                &format!("/api/skills/{id}/file?path=../outside.txt"),
                json!({}),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, snapshot) = fixture.json(Method::POST, "/api/rescan", json!({})).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(snapshot["scanning"], true);
    }

    #[tokio::test]
    async fn source_mutations_and_editor_errors_are_json() {
        let fixture = Fixture::new();
        fixture.scanned().await;
        let external = fixture.directory.path().join("external");
        fs::create_dir(&external).unwrap();
        let (status, workspace) = fixture
            .json(Method::POST, "/api/roots", json!({"path": external}))
            .await;
        assert_eq!(status, StatusCode::OK);
        let id = workspace["roots"]
            .as_array()
            .unwrap()
            .iter()
            .find(|root| root["kind"] == "custom")
            .unwrap()["id"]
            .as_str()
            .unwrap();
        let (status, workspace) = fixture
            .json(Method::DELETE, &format!("/api/roots/{id}"), json!({}))
            .await;
        assert_eq!(status, StatusCode::OK);
        assert!(
            !workspace["roots"]
                .as_array()
                .unwrap()
                .iter()
                .any(|root| root["id"] == id)
        );
        let (status, error) = fixture
            .json(Method::PUT, "/api/editor", json!({"editor": "invalid"}))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error["error"].is_string());
        let (status, _) = fixture
            .json(
                Method::POST,
                "/api/skills/unknown/open",
                json!({"scope": "invalid"}),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn local_access_guards_reject_foreign_hosts_and_mutations() {
        let fixture = Fixture::new();
        for headers in [
            vec![
                ("content-type", "application/json"),
                ("origin", "https://evil.example"),
            ],
            vec![
                ("content-type", "application/json"),
                ("origin", "http://127.0.0.1:9999"),
            ],
            vec![("content-type", "application/json"), ("origin", "null")],
            vec![
                ("content-type", "application/json"),
                ("sec-fetch-site", "cross-site"),
            ],
        ] {
            let (status, _, body) = fixture
                .request(Method::POST, "/api/rescan", "{}", &headers)
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert!(serde_json::from_slice::<Value>(&body).unwrap()["error"].is_string());
        }
        let request = axum::http::Request::builder()
            .uri("/api/workspace")
            .header(header::HOST, "evil.example")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            fixture.app.clone().oneshot(request).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        for host in ["localhost:4173", "127.0.0.1", "[::1]:4173"] {
            assert!(local_host(host));
        }
        for host in [
            "localhost.evil",
            "user@localhost",
            "127.0.0.1:abc",
            "localhost:",
        ] {
            assert!(!local_host(host));
        }
    }

    #[tokio::test]
    async fn request_limits_and_api_fallbacks_have_json_security_headers() {
        let fixture = Fixture::new();
        for (body, headers, expected) in [
            ("{}".to_owned(), vec![], StatusCode::UNSUPPORTED_MEDIA_TYPE),
            (
                "{".to_owned(),
                vec![("content-type", "application/json")],
                StatusCode::BAD_REQUEST,
            ),
            (
                "null".to_owned(),
                vec![("content-type", "application/json")],
                StatusCode::BAD_REQUEST,
            ),
            (
                format!("{{\"large\":\"{}\"}}", "x".repeat(BODY_LIMIT)),
                vec![("content-type", "application/json")],
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let (status, headers, body) = fixture
                .request(Method::POST, "/api/rescan", &body, &headers)
                .await;
            assert_eq!(status, expected);
            assert_eq!(headers["cache-control"], "no-store");
            assert_eq!(headers["x-content-type-options"], "nosniff");
            assert_eq!(headers["referrer-policy"], "no-referrer");
            assert!(serde_json::from_slice::<Value>(&body).unwrap()["error"].is_string());
        }
        for uri in ["/api", "/api/unknown", "/api/skills/%FF"] {
            let (status, _, body) = fixture.request(Method::GET, uri, "", &[]).await;
            assert!(status == StatusCode::NOT_FOUND || status == StatusCode::BAD_REQUEST);
            assert!(serde_json::from_slice::<Value>(&body).unwrap()["error"].is_string());
        }
    }

    #[tokio::test]
    async fn production_static_files_and_spa_routes_are_served() {
        let fixture = Fixture::new();
        for uri in ["/", "/reading/example"] {
            let (status, _, body) = fixture.request(Method::GET, uri, "", &[]).await;
            assert_eq!(status, StatusCode::OK);
            assert!(String::from_utf8(body).unwrap().contains("ZSkills fixture"));
        }
        let (status, _, body) = fixture.request(Method::GET, "/asset.js", "", &[]).await;
        assert_eq!(status, StatusCode::OK);
        assert!(String::from_utf8(body).unwrap().contains("window.fixture"));
    }
}
