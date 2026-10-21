use std::{
    future::Future,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

use super::ProviderModelCatalogSnapshot;

const CACHE_TTL: Duration = Duration::from_secs(60);
const FAILURE_CACHE_TTL: Duration = Duration::from_secs(10);

struct CachedCatalog {
    cached_at: Instant,
    snapshot: ProviderModelCatalogSnapshot,
}

impl CachedCatalog {
    fn is_fresh(&self) -> bool {
        let ttl = if self
            .snapshot
            .providers
            .iter()
            .any(|entry| entry.error.is_some())
        {
            FAILURE_CACHE_TTL
        } else {
            CACHE_TTL
        };
        self.cached_at.elapsed() < ttl
    }
}

#[derive(Default)]
struct CacheState {
    generation: u64,
    catalog: Option<CachedCatalog>,
}

#[derive(Default)]
pub(super) struct ModelCatalogCache {
    state: Mutex<CacheState>,
    refresh: Mutex<()>,
}

impl ModelCatalogCache {
    pub(super) async fn invalidate(&self) {
        let mut state = self.state.lock().await;
        state.generation = state.generation.wrapping_add(1);
        state.catalog = None;
    }

    pub(super) async fn get_or_refresh<F, Fut>(
        &self,
        force_refresh: bool,
        mut load: F,
    ) -> Result<ProviderModelCatalogSnapshot, String>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<ProviderModelCatalogSnapshot, String>>,
    {
        if !force_refresh {
            let state = self.state.lock().await;
            if let Some(cached) = state.catalog.as_ref().filter(|cached| cached.is_fresh()) {
                return Ok(cached.snapshot.clone());
            }
        }
        let requested_at = Instant::now();
        let _refresh = self.refresh.lock().await;
        loop {
            let generation = {
                let state = self.state.lock().await;
                if let Some(cached) = state.catalog.as_ref() {
                    if cached.cached_at >= requested_at || (!force_refresh && cached.is_fresh()) {
                        return Ok(cached.snapshot.clone());
                    }
                }
                state.generation
            };
            let result = load().await;
            let mut state = self.state.lock().await;
            if state.generation != generation {
                continue;
            }
            let mut snapshot = result?;
            if let Some(cached) = state.catalog.as_ref() {
                for provider in &mut snapshot.providers {
                    if provider
                        .error
                        .as_deref()
                        .is_some_and(super::model_catalog::is_retryable_provider_error)
                    {
                        if let Some(previous) = cached.snapshot.providers.iter().find(|entry| {
                            entry.provider == provider.provider
                                && entry.available
                                && !entry.models.is_empty()
                        }) {
                            provider.available = true;
                            provider.models = previous.models.clone();
                        }
                    }
                }
            }
            state.catalog = Some(CachedCatalog {
                cached_at: Instant::now(),
                snapshot: snapshot.clone(),
            });
            return Ok(snapshot);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::Notify;

    fn snapshot(generated_at: u64) -> ProviderModelCatalogSnapshot {
        ProviderModelCatalogSnapshot {
            generated_at,
            providers: Vec::new(),
        }
    }

    #[tokio::test]
    async fn concurrent_requests_share_one_refresh() {
        let cache = ModelCatalogCache::default();
        let calls = AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            tokio::task::yield_now().await;
            Ok(snapshot(1))
        };
        let (first, second, third) = tokio::join!(
            cache.get_or_refresh(false, load),
            cache.get_or_refresh(false, load),
            cache.get_or_refresh(false, load)
        );
        assert_eq!(first.unwrap().generated_at, 1);
        assert_eq!(second.unwrap().generated_at, 1);
        assert_eq!(third.unwrap().generated_at, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn invalidation_during_refresh_is_prompt_and_discards_stale_results() {
        let cache = Arc::new(ModelCatalogCache::default());
        let started = Arc::new(Notify::new());
        let resume = Arc::new(Notify::new());
        let worker = tokio::spawn({
            let cache = cache.clone();
            let started = started.clone();
            let resume = resume.clone();
            async move {
                let calls = AtomicUsize::new(0);
                cache
                    .get_or_refresh(false, || async {
                        let call = calls.fetch_add(1, Ordering::SeqCst);
                        if call == 0 {
                            started.notify_one();
                            resume.notified().await;
                        }
                        Ok(snapshot(call as u64 + 1))
                    })
                    .await
            }
        });
        started.notified().await;
        tokio::time::timeout(Duration::from_secs(1), cache.invalidate())
            .await
            .expect("invalidation must not wait for probes");
        resume.notify_one();
        assert_eq!(worker.await.unwrap().unwrap().generated_at, 2);
        assert_eq!(
            cache
                .get_or_refresh(false, || async { panic!("fresh result should be cached") })
                .await
                .unwrap()
                .generated_at,
            2
        );
    }

    #[tokio::test]
    async fn failures_and_expired_entries_can_be_refreshed() {
        let cache = ModelCatalogCache::default();
        assert!(cache
            .get_or_refresh(false, || async { Err("failed".to_string()) })
            .await
            .is_err());
        assert_eq!(
            cache
                .get_or_refresh(false, || async { Ok(snapshot(1)) })
                .await
                .unwrap()
                .generated_at,
            1
        );
        cache.state.lock().await.catalog.as_mut().unwrap().cached_at = Instant::now() - CACHE_TTL;
        assert_eq!(
            cache
                .get_or_refresh(false, || async { Ok(snapshot(2)) })
                .await
                .unwrap()
                .generated_at,
            2
        );
    }

    #[tokio::test]
    async fn manual_retry_bypasses_fresh_cache() {
        let cache = ModelCatalogCache::default();
        cache
            .get_or_refresh(false, || async { Ok(snapshot(1)) })
            .await
            .unwrap();
        assert_eq!(
            cache
                .get_or_refresh(true, || async { Ok(snapshot(2)) })
                .await
                .unwrap()
                .generated_at,
            2
        );
    }

    #[tokio::test]
    async fn fresh_models_do_not_wait_for_a_background_refresh() {
        let cache = Arc::new(ModelCatalogCache::default());
        cache
            .get_or_refresh(false, || async { Ok(snapshot(1)) })
            .await
            .unwrap();
        let started = Arc::new(Notify::new());
        let resume = Arc::new(Notify::new());
        let worker = tokio::spawn({
            let cache = cache.clone();
            let started = started.clone();
            let resume = resume.clone();
            async move {
                cache
                    .get_or_refresh(true, || async {
                        started.notify_one();
                        resume.notified().await;
                        Ok(snapshot(2))
                    })
                    .await
            }
        });
        started.notified().await;
        let cached = tokio::time::timeout(
            Duration::from_secs(1),
            cache.get_or_refresh(false, || async {
                panic!("cached models must not trigger another probe")
            }),
        )
        .await
        .expect("cached reads must not wait for CLI probes")
        .unwrap();
        assert_eq!(cached.generated_at, 1);
        resume.notify_one();
        assert_eq!(worker.await.unwrap().unwrap().generated_at, 2);
    }

    fn provider_snapshot(available: bool, error: Option<&str>) -> ProviderModelCatalogSnapshot {
        use super::super::{
            ProviderModelCatalogProvider, ProviderRuntimeModel, ProviderRuntimeModelCapabilities,
        };
        ProviderModelCatalogSnapshot {
            generated_at: 1,
            providers: vec![ProviderModelCatalogProvider {
                provider: "codex-cli".to_string(),
                source: "provider-probe".to_string(),
                available,
                error: error.map(str::to_string),
                models: if available {
                    vec![ProviderRuntimeModel {
                        id: "model".to_string(),
                        label: None,
                        stage: None,
                        release_date: None,
                        recommended_for: vec![],
                        capabilities: ProviderRuntimeModelCapabilities {
                            image_input: Some(true),
                            ..Default::default()
                        },
                        warnings: vec![],
                        source: "provider-probe".to_string(),
                    }]
                } else {
                    vec![]
                },
            }],
        }
    }

    #[tokio::test]
    async fn transient_failure_keeps_models_and_features_but_auth_failure_clears_them() {
        let cache = ModelCatalogCache::default();
        cache
            .get_or_refresh(false, || async { Ok(provider_snapshot(true, None)) })
            .await
            .unwrap();
        let stale = cache
            .get_or_refresh(true, || async {
                Ok(provider_snapshot(false, Some("timed out")))
            })
            .await
            .unwrap();
        assert!(stale.providers[0].available);
        assert_eq!(
            stale.providers[0].models[0].capabilities.image_input,
            Some(true)
        );
        assert_eq!(stale.providers[0].error.as_deref(), Some("timed out"));
        let rejected = cache
            .get_or_refresh(true, || async {
                Ok(provider_snapshot(false, Some("HTTP 401")))
            })
            .await
            .unwrap();
        assert!(!rejected.providers[0].available);
        assert!(rejected.providers[0].models.is_empty());
    }
}
