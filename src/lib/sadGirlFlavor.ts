import { supabase } from './supabase/client';

export const SAD_GIRL_FLAVOR_SLUG = 'sad-girl';

export type SadGirlFlavor = {
    id: number;
    slug: string;
    label: string;
    description: string | null;
};

export async function loadSadGirlFlavor(): Promise<SadGirlFlavor> {
    const { data, error } = await supabase
        .from('humor_flavors')
        .select('id, slug, description')
        .eq('slug', SAD_GIRL_FLAVOR_SLUG)
        .maybeSingle();

    if (error) {
        throw new Error(`Failed to load humor flavor "${SAD_GIRL_FLAVOR_SLUG}": ${error.message}`);
    }

    if (!data?.id) {
        throw new Error(
            `Humor flavor "${SAD_GIRL_FLAVOR_SLUG}" was not found in public.humor_flavors.`
        );
    }

    const description =
        typeof data.description === 'string' && data.description.trim().length > 0
            ? data.description.trim()
            : null;
    const slug =
        typeof data.slug === 'string' && data.slug.trim().length > 0
            ? data.slug.trim()
            : SAD_GIRL_FLAVOR_SLUG;

    return {
        id: data.id,
        slug,
        label: slug,
        description,
    };
}
