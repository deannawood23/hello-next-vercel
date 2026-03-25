import { requireUser } from '../../src/lib/auth/requireUser';
import { GalleryClient } from '../components/GalleryClient';

export default async function VotePage() {
    await requireUser();

    return <GalleryClient />;
}
