use std::{
    future::Future,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

use super::ProviderModelCatalogSnapshot;

const CACHE_TTL: Duration = Duration::from_secs(60);

struct CachedCatalog {
    cached_at: Instant,
    snapshot: ProviderModelCatalogSnapshot,
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
        mut load: F,
    ) -> Result<ProviderModelCatalogSnapshot, String>
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = Result<ProviderModelCatalogSnapshot, String>>,
    {
        // Only refreshers wait for probes. Invalidation never waits for network
        // requests or CLI processes, and invalidated results cannot refill the cache.
        let _refresh = self.refresh.lock().await;
        loop {
            let generation = {
                let state = self.state.lock().await;
                if let Some(cached) = state.catalog.as_ref() {
                    if cached.cached_at.elapsed() < CACHE_TTL {
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
            let snapshot = result?;
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
            cache.get_or_refresh(load),
            cache.get_or_refresh(load),
            cache.get_or_refresh(load)
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
                    .get_or_refresh(|| async {
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
                .get_or_refresh(|| async { panic!("fresh result should be cached") })
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
            .get_or_refresh(|| async { Err("failed".to_string()) })
            .await
            .is_err());
        assert_eq!(
            cache
                .get_or_refresh(|| async { Ok(snapshot(1)) })
                .await
                .unwrap()
                .generated_at,
            1
        );
        cache.state.lock().await.catalog.as_mut().unwrap().cached_at = Instant::now() - CACHE_TTL;
        assert_eq!(
            cache
                .get_or_refresh(|| async { Ok(snapshot(2)) })
                .await
                .unwrap()
                .generated_at,
            2
        );
    }
}
