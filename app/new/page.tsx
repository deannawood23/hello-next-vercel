import { requireUser } from '../../src/lib/auth/requireUser';
import { NewPostClient } from '../components/NewPostClient';

export default async function NewPage() {
    await requireUser();

    return <NewPostClient />;
}
