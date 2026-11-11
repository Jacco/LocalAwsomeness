'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import styles from '../accounts.module.css';

export default function NewAccount() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    id: '',
    name: '',
    email: '',
    joinMethod: 'CREATED',
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...formData,
          joinedTimestamp: Date.now(),
          requestedTimestamp: Date.now(),
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to create account');
      }

      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <Link href="/dashboard" className={styles.backButton}>
          ← Back
        </Link>
        <h1>Add New Account</h1>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.formGroup}>
          <label htmlFor="id">Account ID *</label>
          <input
            type="text"
            id="id"
            name="id"
            value={formData.id}
            onChange={handleChange}
            placeholder="e.g., 123456789012"
            required
            pattern="[0-9]{12}"
            title="Must be a 12-digit AWS account ID"
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="name">Account Name *</label>
          <input
            type="text"
            id="name"
            name="name"
            value={formData.name}
            onChange={handleChange}
            placeholder="e.g., Production"
            required
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="email">Email *</label>
          <input
            type="email"
            id="email"
            name="email"
            value={formData.email}
            onChange={handleChange}
            placeholder="contact@example.com"
            required
          />
        </div>

        <div className={styles.formGroup}>
          <label htmlFor="joinMethod">Join Method</label>
          <select
            id="joinMethod"
            name="joinMethod"
            value={formData.joinMethod}
            onChange={handleChange}
          >
            <option value="CREATED">Created</option>
            <option value="INVITED">Invited</option>
            <option value="IMPORTED">Imported</option>
          </select>
        </div>

        <div className={styles.formActions}>
          <button type="submit" className={styles.submitButton} disabled={loading}>
            {loading ? 'Creating...' : 'Create Account'}
          </button>
          <Link href="/dashboard" className={styles.cancelButton}>
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
