'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { loadSadGirlFlavor } from '../../src/lib/sadGirlFlavor';
import { supabase } from '../../src/lib/supabase/client';

type CaptionRow = {
    id: string;
    content: string | null;
    created_datetime_utc: string;
    image_id: string;
    images:
        | {
              id: string;
              url: string | null;
          }
        | {
              id: string;
              url: string | null;
          }[]
        | null;
};

type CaptionSessionItem = {
    imageId: string;
    imageUrl: string | null;
    caption: {
        id: string;
        content: string | null;
        created_datetime_utc: string;
    };
};

const CAPTIONS_PER_SESSION = 10;
const VIEWED_IMAGES_STORAGE_PREFIX = 'viewed-image-ids';
const UPLOAD_PROMPT_STORAGE_KEY = 'seen-upload-prompt';
const UPLOAD_PROMPT_VOTE_COUNT_KEY = 'upload-prompt-vote-count';
const UPLOAD_PROMPT_THRESHOLD = 3;

function shuffleItems<T>(items: T[]): T[] {
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function hasDisplayableCaption(
    item: Pick<CaptionSessionItem, 'imageUrl' | 'caption'>
): boolean {
    const imageUrl = item.imageUrl?.trim();
    const captionContent = item.caption.content?.trim();
    return Boolean(imageUrl && captionContent);
}

export function GalleryClient() {
    const seenCaptionIdsRef = useRef<Set<string>>(new Set());
    const seenImageIdsRef = useRef<Set<string>>(new Set());
    const viewedImageIdsRef = useRef<Set<string>>(new Set());
    const fetchMoreCaptionsRef = useRef<(() => Promise<void>) | null>(null);
    const [captionItems, setCaptionItems] = useState<CaptionSessionItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [currentIndex, setCurrentIndex] = useState(0);
    const [authChecked, setAuthChecked] = useState(false);
    const [userId, setUserId] = useState<string | null>(null);
    const [voteSaving, setVoteSaving] = useState(false);
    const [voteError, setVoteError] = useState<string | null>(null);
    const [votesByCaption, setVotesByCaption] = useState<Record<string, number>>({});
    const [spotlight, setSpotlight] = useState({ x: 50, y: 50, active: false });
    const [sadGirlFlavorId, setSadGirlFlavorId] = useState<number | null>(null);
    const [sadGirlFlavorDescription, setSadGirlFlavorDescription] = useState<string | null>(null);
    const [humorFlavorLoading, setHumorFlavorLoading] = useState(true);
    const [humorFlavorError, setHumorFlavorError] = useState<string | null>(null);
    const [showUploadPrompt, setShowUploadPrompt] = useState(false);

    const currentItem = captionItems[currentIndex] ?? null;
    const nextItem = captionItems[currentIndex + 1] ?? null;
    const isLastCaption = currentIndex >= captionItems.length - 1;
    const selectedVote = currentItem
        ? votesByCaption[currentItem.caption.id] ?? null
        : null;
    const canVote = authChecked && !!userId;

    const preloadImageUrl = useMemo(() => {
        if (!currentItem || !nextItem) {
            return null;
        }
        if (!nextItem.imageUrl || nextItem.imageUrl === currentItem.imageUrl) {
            return null;
        }
        return nextItem.imageUrl;
    }, [currentItem, nextItem]);

    useEffect(() => {
        let isMounted = true;

        const loadOptions = async () => {
            setHumorFlavorLoading(true);
            setHumorFlavorError(null);

            try {
                const flavor = await loadSadGirlFlavor();
                if (!isMounted) {
                    return;
                }

                setSadGirlFlavorId(flavor.id);
                setSadGirlFlavorDescription(flavor.description);
            } catch (error) {
                if (!isMounted) {
                    return;
                }

                setSadGirlFlavorId(null);
                setSadGirlFlavorDescription(null);
                setHumorFlavorError(
                    error instanceof Error ? error.message : 'Failed to load sad-girl.'
                );
            } finally {
                if (isMounted) {
                    setHumorFlavorLoading(false);
                }
            }
        };

        loadOptions();

        return () => {
            isMounted = false;
        };
    }, []);

    useEffect(() => {
        if (!userId || !sadGirlFlavorId) {
            viewedImageIdsRef.current = new Set();
            return;
        }

        const storageKey = `${VIEWED_IMAGES_STORAGE_PREFIX}:${userId}:${sadGirlFlavorId}`;
        try {
            const saved = window.localStorage.getItem(storageKey);
            if (!saved) {
                viewedImageIdsRef.current = new Set();
                return;
            }

            const parsed = JSON.parse(saved) as unknown;
            if (!Array.isArray(parsed)) {
                viewedImageIdsRef.current = new Set();
                return;
            }

            viewedImageIdsRef.current = new Set(
                parsed.filter((value): value is string => typeof value === 'string')
            );
        } catch {
            viewedImageIdsRef.current = new Set();
        }
    }, [sadGirlFlavorId, userId]);

    useEffect(() => {
        if (!userId || !sadGirlFlavorId || !currentItem?.imageId) {
            return;
        }

        if (viewedImageIdsRef.current.has(currentItem.imageId)) {
            return;
        }

        viewedImageIdsRef.current.add(currentItem.imageId);
        const storageKey = `${VIEWED_IMAGES_STORAGE_PREFIX}:${userId}:${sadGirlFlavorId}`;

        try {
            window.localStorage.setItem(
                storageKey,
                JSON.stringify(Array.from(viewedImageIdsRef.current))
            );
        } catch {
            // Ignore localStorage write failures and keep in-memory history.
        }
    }, [currentItem, sadGirlFlavorId, userId]);

    const dismissUploadPrompt = () => {
        setShowUploadPrompt(false);
        try {
            window.localStorage.setItem(UPLOAD_PROMPT_STORAGE_KEY, 'true');
        } catch {
            // Ignore localStorage write failures.
        }
    };

    useEffect(() => {
        let isMounted = true;
        let activeUserId: string | null = null;

        if (!sadGirlFlavorId) {
            setCaptionItems([]);
            setLoading(humorFlavorLoading);
            return () => {
                isMounted = false;
            };
        }

        const fetchVotesForCaptionIds = async (
            profileId: string,
            captionIds: string[]
        ) => {
            if (captionIds.length === 0) {
                return;
            }

            const { data, error: votesError } = await supabase
                .from('caption_votes')
                .select('caption_id, vote_value')
                .eq('profile_id', profileId)
                .in('caption_id', captionIds);

            if (!isMounted || votesError) {
                return;
            }

            const mappedVotes: Record<string, number> = {};
            for (const row of data ?? []) {
                mappedVotes[row.caption_id] = row.vote_value;
            }
            setVotesByCaption((prev) => ({
                ...prev,
                ...mappedVotes,
            }));
        };

        const fetchUser = async () => {
            const { data, error: userError } = await supabase.auth.getUser();

            if (!isMounted) {
                return null;
            }

            if (userError) {
                setUserId(null);
                setAuthChecked(true);
                return null;
            }

            const id = data.user?.id ?? null;
            activeUserId = id;
            setUserId(id);
            setAuthChecked(true);
            return id;
        };

        const fetchImages = async (
            profileId: string | null,
            reset: boolean
        ) => {
            const oneWeekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const { data, error: queryError } = await supabase
                .from('captions')
                .select(
                    'id, content, created_datetime_utc, image_id, images ( id, url )'
                )
                .eq('humor_flavor_id', sadGirlFlavorId)
                .order('created_datetime_utc', { ascending: false });

            if (!isMounted) {
                return;
            }

            if (queryError) {
                setError(queryError.message);
                setCaptionItems([]);
                setVotesByCaption({});
                setLoading(false);
                return;
            }

            const rows = (data ?? []) as CaptionRow[];
            const latestByImage = new Map<string, CaptionSessionItem>();

            for (const row of rows) {
                const image = Array.isArray(row.images) ? row.images[0] ?? null : row.images;
                if (!image?.id) {
                    continue;
                }

                if (latestByImage.has(row.image_id)) {
                    continue;
                }

                latestByImage.set(row.image_id, {
                    imageId: row.image_id,
                    imageUrl: image.url,
                    caption: {
                        id: row.id,
                        content: row.content,
                        created_datetime_utc: row.created_datetime_utc,
                    },
                });
            }

            const latestCaptionPerImage = Array.from(latestByImage.values())
                .filter(hasDisplayableCaption)
                .filter((item) => {
                    const captionCreatedMs = Date.parse(item.caption.created_datetime_utc);
                    return (
                        Number.isFinite(captionCreatedMs) &&
                        captionCreatedMs >= oneWeekAgoMs
                    );
                });

            const unseenImages = shuffleItems(
                latestCaptionPerImage.filter(
                    (item) => !viewedImageIdsRef.current.has(item.imageId)
                )
            );
            const seenImages = shuffleItems(
                latestCaptionPerImage.filter((item) =>
                    viewedImageIdsRef.current.has(item.imageId)
                )
            );
            const sessionCaptions = [...unseenImages, ...seenImages];

            if (reset) {
                const initialBatch = sessionCaptions.slice(0, CAPTIONS_PER_SESSION);
                seenCaptionIdsRef.current = new Set(
                    initialBatch.map((item) => item.caption.id)
                );
                seenImageIdsRef.current = new Set(initialBatch.map((item) => item.imageId));
                setCaptionItems(initialBatch);
                setCurrentIndex(0);
                if (profileId) {
                    await fetchVotesForCaptionIds(
                        profileId,
                        initialBatch.map((item) => item.caption.id)
                    );
                } else {
                    setVotesByCaption({});
                }
                setError(null);
                setLoading(false);
                return;
            }

            const unseenCaptions = sessionCaptions.filter(
                (item) =>
                    !seenCaptionIdsRef.current.has(item.caption.id) &&
                    !seenImageIdsRef.current.has(item.imageId)
            );
            const nextBatch = unseenCaptions.slice(0, CAPTIONS_PER_SESSION);

            if (nextBatch.length > 0) {
                for (const item of nextBatch) {
                    seenCaptionIdsRef.current.add(item.caption.id);
                    seenImageIdsRef.current.add(item.imageId);
                }
                setCaptionItems((prev) => [...prev, ...nextBatch]);
                if (profileId) {
                    await fetchVotesForCaptionIds(
                        profileId,
                        nextBatch.map((item) => item.caption.id)
                    );
                }
            }

            setError(null);
            setLoading(false);
        };

        fetchMoreCaptionsRef.current = async () => {
            await fetchImages(activeUserId, false);
        };

        const bootstrap = async () => {
            const profileId = await fetchUser();
            await fetchImages(profileId, true);
        };

        bootstrap();

        const channel = supabase
            .channel('images-captions-live')
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'images' },
                () => {
                    fetchImages(activeUserId, false);
                }
            )
            .on(
                'postgres_changes',
                { event: '*', schema: 'public', table: 'captions' },
                () => {
                    fetchImages(activeUserId, false);
                }
            )
            .subscribe();

        const pollId = window.setInterval(() => {
            fetchImages(activeUserId, false);
        }, 15000);

        return () => {
            isMounted = false;
            window.clearInterval(pollId);
            supabase.removeChannel(channel);
        };
    }, [humorFlavorLoading, sadGirlFlavorId]);

    const goToNextCaption = () => {
        setVoteError(null);
        const nextIndex = currentIndex < captionItems.length ? currentIndex + 1 : currentIndex;
        setCurrentIndex(nextIndex);
        if (captionItems.length - nextIndex <= 2) {
            void fetchMoreCaptionsRef.current?.();
        }
    };

    const goToPreviousCaption = () => {
        setVoteError(null);
        setCurrentIndex((prev) => (prev > 0 ? prev - 1 : 0));
    };

    const voteOnCaption = async (captionId: string, voteValue: 1 | -1) => {
        setVoteError(null);
        setVoteSaving(true);

        try {
            const {
                data: { user },
                error: userError,
            } = await supabase.auth.getUser();
            if (userError) {
                throw userError;
            }
            if (!user) {
                throw new Error('Not signed in');
            }

            setUserId(user.id);

            const { data: existing, error: selectError } = await supabase
                .from('caption_votes')
                .select('id, vote_value')
                .eq('profile_id', user.id)
                .eq('caption_id', captionId)
                .maybeSingle();

            if (selectError) {
                throw selectError;
            }

            if (existing?.id) {
                const { error: updateError } = await supabase
                    .from('caption_votes')
                    .update({
                        vote_value: voteValue,
                        modified_by_user_id: user.id,
                    })
                    .eq('id', existing.id);

                if (updateError) {
                    throw updateError;
                }
            } else {
                const { error: insertError } = await supabase
                    .from('caption_votes')
                    .insert({
                        profile_id: user.id,
                        caption_id: captionId,
                        vote_value: voteValue,
                        created_by_user_id: user.id,
                        modified_by_user_id: user.id,
                    });

                if (insertError) {
                    throw insertError;
                }
            }

            setVotesByCaption((prev) => ({
                ...prev,
                [captionId]: voteValue,
            }));

            try {
                const hasSeenPrompt = window.localStorage.getItem(UPLOAD_PROMPT_STORAGE_KEY);
                if (!hasSeenPrompt) {
                    const currentCount = Number(
                        window.localStorage.getItem(UPLOAD_PROMPT_VOTE_COUNT_KEY) ?? '0'
                    );
                    const nextCount = currentCount + 1;
                    window.localStorage.setItem(
                        UPLOAD_PROMPT_VOTE_COUNT_KEY,
                        String(nextCount)
                    );
                    if (nextCount >= UPLOAD_PROMPT_THRESHOLD) {
                        setShowUploadPrompt(true);
                    }
                }
            } catch {
                // Ignore localStorage failures and skip the prompt counter.
            }

            goToNextCaption();
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Failed to save vote.';
            if (message === 'Not signed in') {
                setUserId(null);
                setAuthChecked(true);
                setVoteError('Sign in to vote.');
            } else {
                setVoteError(message);
            }
        } finally {
            setVoteSaving(false);
        }
    };

    return (
        <main className="linear-page-bg min-h-screen px-4 py-10 text-[#EDEDEF] sm:px-8">
            <div aria-hidden="true" className="linear-grid absolute inset-0 opacity-100" />
            <div aria-hidden="true" className="linear-noise absolute inset-0 opacity-[0.015]" />
            <div aria-hidden="true" className="ambient-blob ambient-blob-primary" />
            <div aria-hidden="true" className="ambient-blob ambient-blob-secondary" />
            <div aria-hidden="true" className="ambient-blob ambient-blob-tertiary" />
            <div aria-hidden="true" className="ambient-blob ambient-blob-bottom" />
            <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col gap-8">
                {showUploadPrompt && (
                    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/55 px-4">
                        <div className="linear-glass w-full max-w-md rounded-3xl p-6">
                            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-[#8A8F98]">
                                First Time Here
                            </p>
                            <h2 className="mt-3 text-2xl font-semibold text-[#EDEDEF]">
                                Upload your own image too
                            </h2>
                            <p className="mt-3 text-sm leading-6 text-[#B8BDC8]">
                                You can keep voting, or open New Post to upload an image and
                                generate more captions in your sad-girl humor flavor.
                            </p>
                            <div className="mt-6 flex items-center gap-3">
                                <Link
                                    href="/new"
                                    onClick={dismissUploadPrompt}
                                    className="inline-flex rounded-lg border border-[#5E6AD2]/50 bg-[#5E6AD2] px-4 py-2 text-sm font-semibold text-white shadow-[0_0_0_1px_rgba(94,106,210,0.5),0_4px_12px_rgba(94,106,210,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] transition duration-200 ease-out hover:bg-[#6872D9]"
                                >
                                    Go to New Post
                                </Link>
                                <button
                                    type="button"
                                    onClick={dismissUploadPrompt}
                                    className="inline-flex rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08]"
                                >
                                    Keep Voting
                                </button>
                            </div>
                        </div>
                    </div>
                )}
                <header className="space-y-3 pt-8 sm:pt-12">
                    <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-[#8A8F98]">
                        See what&apos;s cookin
                    </p>
                    <h1 className="bg-gradient-to-b from-white via-white/95 to-white/65 bg-clip-text font-[var(--font-playfair)] text-4xl font-semibold leading-tight tracking-tight text-transparent sm:text-5xl">
                        Newest Crackd Captions 👩‍🍳
                    </h1>
                </header>

                <section className="linear-glass space-y-3 rounded-2xl p-4 sm:p-6">
                    <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#8A8F98]">
                        Humor Flavor
                    </p>
                    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
                        <p className="text-base font-semibold text-[#EDEDEF]">sad-girl</p>
                        {sadGirlFlavorDescription && (
                            <p className="mt-1 text-sm leading-6 text-[#B8BDC8]">
                                {sadGirlFlavorDescription}
                            </p>
                        )}
                    </div>
                    {humorFlavorError && (
                        <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                            {humorFlavorError}
                        </p>
                    )}
                </section>

                {loading && <p className="text-[#8A8F98]">Loading...</p>}
                {error && !loading && (
                    <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-rose-200">
                        Error: {error}
                    </p>
                )}

                {!loading && !error && (
                    <section
                        className="linear-glass relative overflow-hidden space-y-4 rounded-2xl p-4 pb-24 sm:p-6 sm:pb-24"
                        onMouseMove={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            const x = ((event.clientX - rect.left) / rect.width) * 100;
                            const y = ((event.clientY - rect.top) / rect.height) * 100;
                            setSpotlight({ x, y, active: true });
                        }}
                        onMouseLeave={() =>
                            setSpotlight((prev) => ({ ...prev, active: false }))
                        }
                    >
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 transition-opacity duration-300 ease-out"
                            style={{
                                opacity: spotlight.active ? 1 : 0,
                                background: `radial-gradient(300px circle at ${spotlight.x}% ${spotlight.y}%, rgba(94,106,210,0.16), transparent 60%)`,
                            }}
                        />
                        {currentItem?.imageUrl && (
                            <img
                                src={currentItem.imageUrl}
                                alt=""
                                className="relative z-10 h-auto w-full rounded-xl border border-white/10"
                            />
                        )}

                        {preloadImageUrl && (
                            <img
                                src={preloadImageUrl}
                                alt=""
                                aria-hidden="true"
                                className="hidden"
                            />
                        )}

                        {captionItems.length === 0 && (
                            <p className="text-[#8A8F98]">No captions available yet.</p>
                        )}

                        {!currentItem && captionItems.length > 0 && (
                            <>
                                <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-lg text-[#EDEDEF]">
                                    You&apos;re done.
                                </p>
                                <div className="flex flex-wrap gap-3 pt-1">
                                    <button
                                        type="button"
                                        onClick={goToPreviousCaption}
                                        className="rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                        disabled={currentIndex === 0 || voteSaving}
                                    >
                                        Back
                                    </button>
                                </div>
                            </>
                        )}

                        {currentItem && (
                            <>
                                <p className="font-mono text-xs tracking-widest text-[#8A8F98]">
                                    Caption {currentIndex + 1} of {captionItems.length}
                                </p>
                                <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-lg text-[#EDEDEF]">
                                    {currentItem.caption.content}
                                </p>

                                {!canVote && (
                                    <p className="text-sm text-[#8A8F98]">
                                        Sign in to vote.{' '}
                                        <a
                                            href="/login"
                                            className="font-semibold text-[#EDEDEF] underline decoration-[#5E6AD2]/70 underline-offset-2"
                                        >
                                            Go to login
                                        </a>
                                    </p>
                                )}

                                <div className="space-y-3 pt-1">
                                    <div className="flex w-full items-center justify-center gap-8">
                                        <button
                                            type="button"
                                            onClick={() => voteOnCaption(currentItem.caption.id, 1)}
                                            aria-label="Upvote"
                                            className={`inline-flex h-24 w-72 max-w-[45%] flex-col items-center justify-center gap-2 rounded-xl border px-4 text-5xl leading-none transition duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-60 ${
                                                selectedVote === 1
                                                    ? 'border border-[#5E6AD2]/50 bg-[#5E6AD2] text-white shadow-[0_0_0_1px_rgba(94,106,210,0.5),0_4px_12px_rgba(94,106,210,0.3),inset_0_1px_0_rgba(255,255,255,0.2)]'
                                                    : 'border border-white/10 bg-white/[0.04] text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:border-white/20 hover:bg-white/[0.08]'
                                            }`}
                                            disabled={!canVote || voteSaving}
                                        >
                                            <svg
                                                aria-hidden="true"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.9"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                className="h-10 w-10"
                                            >
                                                <path d="M7 10v10" />
                                                <path d="M11 20h7.2a2 2 0 0 0 2-1.6l1-5a2 2 0 0 0-2-2.4h-4.1l.7-3.2a2 2 0 0 0-2-2.4H12l-3 4.6V20" />
                                                <path d="M3 10h4v10H3z" />
                                            </svg>
                                            <span className="text-sm font-semibold tracking-wide">
                                                Funny
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => voteOnCaption(currentItem.caption.id, -1)}
                                            aria-label="Downvote"
                                            className={`inline-flex h-24 w-72 max-w-[45%] flex-col items-center justify-center gap-2 rounded-xl border px-4 text-5xl leading-none transition duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-60 ${
                                                selectedVote === -1
                                                    ? 'border border-white/20 bg-white/[0.14] text-white shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_4px_14px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.2)]'
                                                    : 'border border-white/10 bg-white/[0.04] text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:border-white/20 hover:bg-white/[0.08]'
                                            }`}
                                            disabled={!canVote || voteSaving}
                                        >
                                            <svg
                                                aria-hidden="true"
                                                viewBox="0 0 24 24"
                                                fill="none"
                                                stroke="currentColor"
                                                strokeWidth="1.9"
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                className="h-10 w-10"
                                            >
                                                <path d="M17 14V4" />
                                                <path d="M13 4H5.8a2 2 0 0 0-2 1.6l-1 5A2 2 0 0 0 4.8 13h4.1l-.7 3.2a2 2 0 0 0 2 2.4H12l3-4.6V4" />
                                                <path d="M21 4h-4v10h4z" />
                                            </svg>
                                            <span className="text-sm font-semibold tracking-wide">
                                                Not funny
                                            </span>
                                        </button>
                                    </div>
                                    <div className="absolute bottom-4 left-4 right-4 flex w-auto items-center sm:bottom-6 sm:left-6 sm:right-6">
                                        <button
                                            type="button"
                                            onClick={goToPreviousCaption}
                                            className="mr-auto rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                            disabled={currentIndex === 0 || voteSaving}
                                        >
                                            Previous
                                        </button>
                                        <button
                                            type="button"
                                            onClick={goToNextCaption}
                                            className="ml-auto rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                            disabled={isLastCaption || voteSaving}
                                        >
                                            Skip
                                        </button>
                                    </div>
                                </div>

                                {voteError && (
                                    <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                                        {voteError}
                                    </p>
                                )}
                            </>
                        )}
                    </section>
                )}
            </div>
        </main>
    );
}
