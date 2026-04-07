'use client';

import { useEffect, useMemo, useState } from 'react';
import { loadSadGirlFlavor } from '../../src/lib/sadGirlFlavor';
import { supabase } from '../../src/lib/supabase/client';

const PIPELINE_BASE_URL = 'https://api.almostcrackd.ai';
const SUPPORTED_IMAGE_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
]);
const FILE_INPUT_ACCEPT = Array.from(SUPPORTED_IMAGE_TYPES).join(',');

type PersistedCaption = {
    id: string | null;
    content: string;
};

function parseErrorMessage(data: unknown, fallback: string): string {
    if (!data || typeof data !== 'object') {
        return fallback;
    }

    const details = data as { message?: unknown; error?: unknown; detail?: unknown };
    const candidate = details.message ?? details.error ?? details.detail;
    return typeof candidate === 'string' && candidate.trim().length > 0
        ? candidate
        : fallback;
}

function parseCaptionList(data: unknown): string[] {
    const normalize = (value: unknown): string | null => {
        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : null;
        }
        if (!value || typeof value !== 'object') {
            return null;
        }
        const record = value as {
            content?: unknown;
            caption?: unknown;
            text?: unknown;
            captionText?: unknown;
            caption_text?: unknown;
            generated_caption?: unknown;
        };
        const field =
            record.content ??
            record.caption ??
            record.text ??
            record.captionText ??
            record.caption_text ??
            record.generated_caption;
        if (typeof field !== 'string') {
            return null;
        }
        const trimmed = field.trim();
        return trimmed.length > 0 ? trimmed : null;
    };

    const collect = (value: unknown, target: string[]) => {
        if (!Array.isArray(value)) {
            return;
        }
        for (const row of value) {
            const next = normalize(row);
            if (next) {
                target.push(next);
            }
        }
    };

    const captions: string[] = [];
    if (Array.isArray(data)) {
        collect(data, captions);
        return captions;
    }

    if (data && typeof data === 'object') {
        const record = data as {
            captions?: unknown;
            data?: unknown;
            results?: unknown;
        };
        collect(record.captions, captions);
        collect(record.results, captions);
        if (record.data && typeof record.data === 'object') {
            const nested = record.data as { captions?: unknown; results?: unknown };
            collect(nested.captions, captions);
            collect(nested.results, captions);
        } else {
            collect(record.data, captions);
        }
    }

    return captions;
}

function shouldRetryWithDifferentHumorFlavor(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
        normalized.includes('humor flavor steps not found') ||
        (normalized.includes('humorflavorid') && normalized.includes('not found'))
    );
}

function delay(ms: number) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, ms);
    });
}

async function fetchGeneratedCaptions(
    imageId: string,
    humorFlavorId: number
): Promise<PersistedCaption[]> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data, error } = await supabase
            .from('captions')
            .select('id, content, created_datetime_utc')
            .eq('image_id', imageId)
            .eq('humor_flavor_id', humorFlavorId)
            .order('created_datetime_utc', { ascending: false })
            .limit(20);

        if (error) {
            throw new Error(`Failed to load generated captions: ${error.message}`);
        }

        const captions = (data ?? [])
            .map((row) => ({
                id: typeof row.id === 'string' ? row.id : null,
                content: typeof row.content === 'string' ? row.content.trim() : '',
            }))
            .filter((row) => row.content.length > 0);

        if (captions.length > 0) {
            return captions;
        }

        if (attempt < 4) {
            await delay(700);
        }
    }

    return [];
}

async function fetchVotesForCaptionIds(
    profileId: string,
    captionIds: string[]
): Promise<Record<string, number>> {
    if (captionIds.length === 0) {
        return {};
    }

    const { data, error } = await supabase
        .from('caption_votes')
        .select('caption_id, vote_value')
        .eq('profile_id', profileId)
        .in('caption_id', captionIds);

    if (error) {
        throw new Error(`Failed to load votes: ${error.message}`);
    }

    const mappedVotes: Record<string, number> = {};
    for (const row of data ?? []) {
        mappedVotes[row.caption_id] = row.vote_value;
    }
    return mappedVotes;
}

export function NewPostClient() {
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const [statusMessage, setStatusMessage] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [captions, setCaptions] = useState<PersistedCaption[]>([]);
    const [captionIndex, setCaptionIndex] = useState(0);
    const [sadGirlFlavorId, setSadGirlFlavorId] = useState<number | null>(null);
    const [sadGirlFlavorDescription, setSadGirlFlavorDescription] = useState<string | null>(null);
    const [humorFlavorError, setHumorFlavorError] = useState<string | null>(null);
    const [humorFlavorLoading, setHumorFlavorLoading] = useState(true);
    const [userId, setUserId] = useState<string | null>(null);
    const [authChecked, setAuthChecked] = useState(false);
    const [voteSaving, setVoteSaving] = useState(false);
    const [voteError, setVoteError] = useState<string | null>(null);
    const [votesByCaption, setVotesByCaption] = useState<Record<string, number>>({});

    const currentCaption = captions[captionIndex] ?? null;
    const isFirstCaption = captionIndex <= 0;
    const isLastCaption = captionIndex >= captions.length - 1;
    const fileLabel = useMemo(() => selectedFile?.name ?? 'No file selected', [selectedFile]);
    const canVote = authChecked && !!userId;
    const selectedVote =
        currentCaption?.id ? votesByCaption[currentCaption.id] ?? null : null;

    useEffect(() => {
        let isMounted = true;

        const bootstrap = async () => {
            setHumorFlavorLoading(true);
            setHumorFlavorError(null);

            try {
                const [{ data: userData, error: userError }, flavor] = await Promise.all([
                    supabase.auth.getUser(),
                    loadSadGirlFlavor(),
                ]);

                if (!isMounted) {
                    return;
                }

                if (userError) {
                    setUserId(null);
                } else {
                    setUserId(userData.user?.id ?? null);
                }

                setAuthChecked(true);
                setSadGirlFlavorId(flavor.id);
                setSadGirlFlavorDescription(flavor.description);
            } catch (error) {
                if (!isMounted) {
                    return;
                }

                setSadGirlFlavorId(null);
                setSadGirlFlavorDescription(null);
                setAuthChecked(true);
                setHumorFlavorError(
                    error instanceof Error ? error.message : 'Failed to load sad-girl.'
                );
            } finally {
                if (isMounted) {
                    setHumorFlavorLoading(false);
                }
            }
        };

        bootstrap();

        return () => {
            isMounted = false;
        };
    }, []);

    const generateCaptionsForFlavor = async (
        authHeaders: Record<string, string>,
        imageId: string,
        humorFlavorId: number
    ) => {
        const response = await fetch(`${PIPELINE_BASE_URL}/pipeline/generate-captions`, {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ imageId, humorFlavorId }),
        });

        const data = (await response.json().catch(() => [])) as unknown;
        return { response, data };
    };

    const onFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] ?? null;
        setErrorMessage(null);
        setStatusMessage(null);
        setCaptions([]);
        setCaptionIndex(0);
        setImageUrl(null);
        setVotesByCaption({});
        setVoteError(null);

        if (!file) {
            setSelectedFile(null);
            return;
        }

        if (!SUPPORTED_IMAGE_TYPES.has(file.type)) {
            setSelectedFile(null);
            setErrorMessage(
                `Unsupported file type: ${file.type || 'unknown'}. Use JPEG, PNG, WEBP, GIF, or HEIC.`
            );
            return;
        }

        setSelectedFile(file);
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
            setAuthChecked(true);

            const { data: existing, error: selectError } = await supabase
                .from('caption_votes')
                .select('id')
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
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Failed to save vote.';
            if (message === 'Not signed in') {
                setUserId(null);
                setAuthChecked(true);
                setVoteError('Sign in to vote on generated captions.');
            } else {
                setVoteError(message);
            }
        } finally {
            setVoteSaving(false);
        }
    };

    const generateCaptions = async () => {
        if (!selectedFile) {
            setErrorMessage('Choose an image first.');
            return;
        }
        if (!sadGirlFlavorId) {
            setErrorMessage('sad-girl is not configured in Supabase yet.');
            return;
        }

        setUploading(true);
        setErrorMessage(null);
        setVoteError(null);
        setStatusMessage('Generating presigned upload URL...');
        setCaptions([]);
        setCaptionIndex(0);
        setImageUrl(null);
        setVotesByCaption({});

        try {
            const {
                data: { session },
                error: sessionError,
            } = await supabase.auth.getSession();

            if (sessionError) {
                throw new Error(sessionError.message);
            }

            if (!session?.access_token) {
                throw new Error('Missing access token. Sign in again and retry.');
            }

            const authHeaders = {
                Authorization: `Bearer ${session.access_token}`,
                'Content-Type': 'application/json',
            };

            const presignResponse = await fetch(
                `${PIPELINE_BASE_URL}/pipeline/generate-presigned-url`,
                {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify({ contentType: selectedFile.type }),
                }
            );
            const presignData = (await presignResponse.json()) as {
                presignedUrl?: string;
                cdnUrl?: string;
            };

            if (!presignResponse.ok || !presignData.presignedUrl || !presignData.cdnUrl) {
                throw new Error(
                    parseErrorMessage(presignData, 'Failed to generate upload URL.')
                );
            }

            setStatusMessage('Uploading image...');
            const uploadResponse = await fetch(presignData.presignedUrl, {
                method: 'PUT',
                headers: { 'Content-Type': selectedFile.type },
                body: selectedFile,
            });

            if (!uploadResponse.ok) {
                throw new Error(`Image upload failed with status ${uploadResponse.status}.`);
            }

            setImageUrl(presignData.cdnUrl);
            setStatusMessage('Registering image in pipeline...');

            const registerResponse = await fetch(
                `${PIPELINE_BASE_URL}/pipeline/upload-image-from-url`,
                {
                    method: 'POST',
                    headers: authHeaders,
                    body: JSON.stringify({
                        imageUrl: presignData.cdnUrl,
                        isCommonUse: false,
                    }),
                }
            );
            const registerData = (await registerResponse.json().catch(() => ({}))) as {
                imageId?: string;
                message?: string;
            };

            if (!registerResponse.ok || !registerData.imageId) {
                throw new Error(
                    parseErrorMessage(registerData, 'Failed to register image URL.')
                );
            }

            setStatusMessage('Generating sad-girl captions...');
            const { response: generateResponse, data: generatedData } =
                await generateCaptionsForFlavor(authHeaders, registerData.imageId, sadGirlFlavorId);

            if (!generateResponse.ok) {
                const message = parseErrorMessage(generatedData, 'Failed to generate captions.');
                if (shouldRetryWithDifferentHumorFlavor(message)) {
                    throw new Error(
                        `sad-girl exists in public.humor_flavors, but the pipeline has no steps for humor_flavor_id ${sadGirlFlavorId}.`
                    );
                }
                throw new Error(message);
            }

            const persistedCaptions = await fetchGeneratedCaptions(
                registerData.imageId,
                sadGirlFlavorId
            );
            const fallbackCaptions = parseCaptionList(generatedData).map((content) => ({
                id: null,
                content,
            }));
            const nextCaptions =
                persistedCaptions.length > 0 ? persistedCaptions : fallbackCaptions;

            setCaptions(nextCaptions);
            setCaptionIndex(0);

            if (userId) {
                const captionIds = nextCaptions
                    .map((caption) => caption.id)
                    .filter((captionId): captionId is string => Boolean(captionId));
                if (captionIds.length > 0) {
                    const existingVotes = await fetchVotesForCaptionIds(userId, captionIds);
                    setVotesByCaption(existingVotes);
                }
            }

            setStatusMessage(
                nextCaptions.length > 0
                    ? persistedCaptions.length > 0
                        ? 'sad-girl captions generated and ready for voting.'
                        : 'Captions generated, but the saved caption rows were not available yet.'
                    : 'No captions were returned for this image.'
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'Unexpected upload failure.';
            setErrorMessage(message);
            setStatusMessage(null);
        } finally {
            setUploading(false);
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
                <header className="space-y-3 pt-8 sm:pt-12">
                    <p className="font-mono text-[11px] uppercase tracking-[0.24em] text-[#8A8F98]">
                        New Post
                    </p>
                    <h1 className="bg-gradient-to-b from-white via-white/95 to-white/65 bg-clip-text font-[var(--font-playfair)] text-4xl font-semibold leading-tight tracking-tight text-transparent sm:text-5xl">
                        Upload an image and generate sad-girl captions
                    </h1>
                </header>

                <section className="linear-glass space-y-4 rounded-2xl p-4 sm:p-6">
                    <div className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
                        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#8A8F98]">
                            Humor Flavor
                        </p>
                        <p className="mt-2 text-base font-semibold text-[#EDEDEF]">sad-girl</p>
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

                    <input
                        type="file"
                        accept={FILE_INPUT_ACCEPT}
                        onChange={onFileSelect}
                        disabled={uploading}
                        className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-[#EDEDEF] file:mr-3 file:rounded-md file:border-0 file:bg-[#5E6AD2] file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-white disabled:cursor-not-allowed disabled:opacity-60"
                    />
                    <p className="text-sm text-[#8A8F98]">{fileLabel}</p>

                    <button
                        type="button"
                        onClick={generateCaptions}
                        disabled={!selectedFile || uploading || humorFlavorLoading || !sadGirlFlavorId}
                        className="rounded-lg border border-[#5E6AD2]/50 bg-[#5E6AD2] px-4 py-2 text-sm font-semibold text-white shadow-[0_0_0_1px_rgba(94,106,210,0.5),0_4px_12px_rgba(94,106,210,0.3),inset_0_1px_0_rgba(255,255,255,0.2)] transition duration-200 ease-out hover:bg-[#6872D9] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        {uploading ? 'Processing...' : 'Generate Captions'}
                    </button>

                    {statusMessage && (
                        <p className="rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-100">
                            {statusMessage}
                        </p>
                    )}

                    {errorMessage && (
                        <p className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                            {errorMessage}
                        </p>
                    )}
                </section>

                {imageUrl && (
                    <section className="linear-glass space-y-4 rounded-2xl p-4 sm:p-6">
                        <img
                            src={imageUrl}
                            alt="Uploaded image"
                            className="h-auto w-full rounded-xl border border-white/10"
                        />

                        {currentCaption && (
                            <>
                                <p className="font-mono text-xs tracking-widest text-[#8A8F98]">
                                    Caption {captionIndex + 1} of {captions.length}
                                </p>
                                <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3 text-lg text-[#EDEDEF]">
                                    {currentCaption.content}
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

                                {!currentCaption.id && (
                                    <p className="text-sm text-[#8A8F98]">
                                        Voting unlocks once the generated caption row is available in
                                        Supabase.
                                    </p>
                                )}

                                <div className="space-y-3 pt-1">
                                    <div className="flex w-full items-center justify-center gap-8">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                currentCaption.id &&
                                                voteOnCaption(currentCaption.id, 1)
                                            }
                                            aria-label="Upvote"
                                            className={`inline-flex h-24 w-72 max-w-[45%] flex-col items-center justify-center gap-2 rounded-xl border px-4 text-5xl leading-none transition duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-60 ${
                                                selectedVote === 1
                                                    ? 'border border-[#5E6AD2]/50 bg-[#5E6AD2] text-white shadow-[0_0_0_1px_rgba(94,106,210,0.5),0_4px_12px_rgba(94,106,210,0.3),inset_0_1px_0_rgba(255,255,255,0.2)]'
                                                    : 'border border-white/10 bg-white/[0.04] text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:border-white/20 hover:bg-white/[0.08]'
                                            }`}
                                            disabled={!canVote || voteSaving || !currentCaption.id}
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
                                            onClick={() =>
                                                currentCaption.id &&
                                                voteOnCaption(currentCaption.id, -1)
                                            }
                                            aria-label="Downvote"
                                            className={`inline-flex h-24 w-72 max-w-[45%] flex-col items-center justify-center gap-2 rounded-xl border px-4 text-5xl leading-none transition duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-60 ${
                                                selectedVote === -1
                                                    ? 'border border-white/20 bg-white/[0.14] text-white shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_4px_14px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.2)]'
                                                    : 'border border-white/10 bg-white/[0.04] text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] hover:border-white/20 hover:bg-white/[0.08]'
                                            }`}
                                            disabled={!canVote || voteSaving || !currentCaption.id}
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

                                    <div className="flex w-full items-center">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setCaptionIndex((prev) => (prev > 0 ? prev - 1 : 0))
                                            }
                                            disabled={isFirstCaption || voteSaving}
                                            className="mr-auto rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            Back
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                setCaptionIndex((prev) =>
                                                    prev < captions.length - 1 ? prev + 1 : prev
                                                )
                                            }
                                            disabled={isLastCaption || voteSaving}
                                            className="ml-auto rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                        >
                                            Next
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
