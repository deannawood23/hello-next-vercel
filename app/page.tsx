import { requireUser } from '../src/lib/auth/requireUser';
import { GalleryClient } from './components/GalleryClient';

export default async function Home() {
    await requireUser();

    return <GalleryClient />;
}
