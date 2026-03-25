'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { supabase } from '../../src/lib/supabase/client';

const NAV_ITEMS = [
    { href: '/vote', label: 'Vote' },
    { href: '/new', label: 'New Post' },
];

export function AppShell() {
    const pathname = usePathname();
    const router = useRouter();
    const [userEmail, setUserEmail] = useState<string | null>(null);
    const [signingOut, setSigningOut] = useState(false);

    useEffect(() => {
        console.log('navbar mounted');

        let isMounted = true;
        const loadUser = async () => {
            const {
                data: { user },
            } = await supabase.auth.getUser();

            if (!isMounted) {
                return;
            }

            setUserEmail(user?.email ?? null);
        };

        loadUser();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            setUserEmail(session?.user?.email ?? null);
        });

        return () => {
            isMounted = false;
            subscription.unsubscribe();
        };
    }, []);

    const handleSignOut = async () => {
        setSigningOut(true);
        const { error } = await supabase.auth.signOut();
        if (error) {
            setSigningOut(false);
            return;
        }
        router.push('/login');
        router.refresh();
    };

    return (
        <header className="fixed left-0 right-0 top-0 z-[100] border-b border-white/15 bg-[#050506] shadow-[0_8px_30px_rgba(0,0,0,0.45)]">
            <span
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: '<!-- NAVBAR_MOUNTED -->' }}
            />
            <div className="mx-auto flex w-full max-w-6xl items-center justify-end gap-3 px-4 py-3 sm:px-6">
                <nav className="flex items-center gap-2 sm:gap-3">
                    {NAV_ITEMS.map((item) => {
                        const isActive =
                            pathname === item.href ||
                            pathname.startsWith(`${item.href}/`) ||
                            (item.href === '/vote' && pathname === '/') ||
                            (item.href === '/new' &&
                                (pathname === '/new-post' ||
                                    pathname.startsWith('/new-post/')));
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
                                    isActive
                                        ? 'border border-[#5E6AD2]/50 bg-[#5E6AD2] text-white shadow-[0_0_0_1px_rgba(94,106,210,0.5),0_4px_12px_rgba(94,106,210,0.3),inset_0_1px_0_rgba(255,255,255,0.2)]'
                                        : 'text-[#EDEDEF] hover:bg-white/[0.08]'
                                } ${isActive ? 'active' : ''}`}
                                data-active={isActive ? 'true' : 'false'}
                            >
                                {item.label}
                            </Link>
                        );
                    })}
                </nav>
                {userEmail ? (
                    <details className="group relative">
                        <summary
                            className="inline-flex h-10 w-10 list-none items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-[#EDEDEF] shadow-[0_2px_20px_rgba(0,0,0,0.45)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#5E6AD2]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#050506]"
                            aria-label="Account"
                        >
                            <svg
                                aria-hidden="true"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-5 w-5"
                            >
                                <path d="M20 21a8 8 0 0 0-16 0" />
                                <circle cx="12" cy="8" r="4" />
                            </svg>
                        </summary>
                        <div className="linear-glass absolute right-0 mt-2 w-64 rounded-2xl p-4">
                            <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#8A8F98]">
                                Signed in as
                            </p>
                            <p className="mt-1 text-sm font-semibold text-[#EDEDEF]">
                                {userEmail}
                            </p>
                            <button
                                type="button"
                                onClick={handleSignOut}
                                className="mt-4 w-full rounded-lg border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-semibold text-[#EDEDEF] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)] transition duration-200 ease-out hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                                disabled={signingOut}
                            >
                                Log out
                            </button>
                        </div>
                    </details>
                ) : (
                    <Link
                        href="/login"
                        className="rounded-lg border border-white/20 bg-white/[0.05] px-3 py-2 text-sm font-semibold text-[#EDEDEF] transition hover:bg-white/[0.1]"
                    >
                        Login
                    </Link>
                )}
            </div>
        </header>
    );
}
