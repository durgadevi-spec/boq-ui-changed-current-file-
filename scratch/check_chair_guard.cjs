const { Client } = require('pg');
const client = new Client({
    connectionString: 'postgresql://postgres.kfbquadkplnnqovsbnji:Durga%219Qx%407B%2325Lm@aws-1-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        await client.connect();
        const projectName = 'Chair guard -ODC 1';
        const res = await client.query('SELECT id, name FROM boq_projects WHERE name = $1', [projectName]);
        console.log('Projects:', JSON.stringify(res.rows, null, 2));
        
        if (res.rows.length > 0) {
            const projectId = res.rows[0].id;
            const versions = await client.query('SELECT id, version_number, status, type, is_cleared FROM boq_versions WHERE project_id = $1 ORDER BY version_number DESC', [projectId]);
            console.log('Versions:', JSON.stringify(versions.rows, null, 2));
        } else {
            console.log('Project not found. Searching with LIKE...');
            const res2 = await client.query('SELECT id, name FROM boq_projects WHERE name LIKE $1', [`%${projectName}%`]);
            console.log('Search Results:', JSON.stringify(res2.rows, null, 2));
            if (res2.rows.length > 0) {
                 const projectId = res2.rows[0].id;
                 const versions = await client.query('SELECT id, version_number, status, type, is_cleared FROM boq_versions WHERE project_id = $1 ORDER BY version_number DESC', [projectId]);
                 console.log('Versions:', JSON.stringify(versions.rows, null, 2));
            }
        }
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}

run();
