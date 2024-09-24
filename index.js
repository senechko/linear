import { GraphQLClient } from 'graphql-request';
import dotenv from 'dotenv';
import fs from 'fs';

// Load environment variables from a .env file
dotenv.config();

const client = new GraphQLClient('https://api.linear.app/graphql', {
  headers: {
    Authorization: `${process.env.LINEAR_API_KEY}`,
  },
});

// Define the date range for Q3 2024
const startDate = "2024-07-01T00:00:00Z";
const endDate = "2024-10-01T00:00:00Z";

const teamsQuery = `
  query {
    teams(filter: { name: { startsWith: "Squad" } }) {
      nodes {
        id
        name
        cycles(
          filter: { 
            endsAt: { 
              gte: "2024-07-01T00:00:00Z",
              lt: "2024-10-01T00:00:00Z"
            }
          }
        ) {
          nodes {
            id
            number
            startsAt
            endsAt
            issueCountHistory
            completedIssueCountHistory
          }
        }
      }
    }
  }
`;

// need a second query because the complexity is too high to include in first query and linear rejects the request
const scopeChangeQuery = `
  query {
    teams(filter: { name: { startsWith: "Squad" } }) {
      nodes {
        id
        cycles(
          filter: { 
            endsAt: { 
              gte: "2024-07-01T00:00:00Z",
              lt: "2024-10-01T00:00:00Z"
            }
          }
        ) {
          nodes {
            id
            scopeHistory
          }
        }
      }
    }
  }
`;

const main = async () => {
  try {
    const [teamsData, scopeChangeData] = await Promise.all([
      client.request(teamsQuery),
      client.request(scopeChangeQuery)
    ]);

    const teams = teamsData.teams.nodes;
    const scopeChanges = new Map();

    // Process scope changes
    scopeChangeData.teams.nodes.forEach(team => {
      team.cycles.nodes.forEach(cycle => {
        const initialScope = cycle.scopeHistory[0] || 0;
        const finalScope = cycle.scopeHistory[cycle.scopeHistory.length - 1] || 0;
        const scopeChange = finalScope - initialScope;
        scopeChanges.set(cycle.id, scopeChange);
      });
    });
    
    const currentDate = new Date();
    
    let rows = [];
    
    teams.forEach(team => {
      if (team.name === "Squad Enablement") return;

      team.cycles.nodes.forEach(cycle => {
        if (new Date(cycle.endsAt) > currentDate) return;

        const totalIssueCount = cycle.issueCountHistory[cycle.issueCountHistory.length - 1];
        const completedIssueCount = cycle.completedIssueCountHistory[cycle.completedIssueCountHistory.length - 1];
        const scopeChange = scopeChanges.get(cycle.id) || 0;
        
        const completionPercentage = totalIssueCount > 0 
          ? Math.round((completedIssueCount / totalIssueCount) * 100)
          : 0;
        
        const capacityAccuracy = (totalIssueCount - scopeChange) !== 0
          ? Math.round((completedIssueCount / (totalIssueCount - scopeChange)) * 100)
          : 'N/A';
        
        const startDate = new Date(cycle.startsAt).toISOString().split('T')[0];
        const endDate = new Date(cycle.endsAt).toISOString().split('T')[0];
        
        rows.push({
          team: team.name,
          cycleNumber: cycle.number,
          startDate,
          endDate,
          totalIssues: totalIssueCount,
          completedIssues: completedIssueCount,
          completionPercentage,
          scopeChange,
          capacityAccuracy
        });
      });
    });
    
    rows.sort((a, b) => {
      if (a.team !== b.team) return a.team.localeCompare(b.team);
      return b.cycleNumber - a.cycleNumber;
    });
    
    const csvRows = rows.map(row => 
      `${row.team},${row.cycleNumber},${row.startDate},${row.endDate},${row.totalIssues},${row.completedIssues},${row.completionPercentage},${row.scopeChange},${row.capacityAccuracy}`
    );
    
    csvRows.unshift('Team,Cycle Number,Cycle Start Date,Cycle End Date,Total Issues,Completed Issues,Completion Percentage,Scope Change,Capacity Accuracy (%)');
    
    const csvContent = csvRows.join('\n');
    
    fs.writeFileSync('team_cycle_data.csv', csvContent);
    console.log('CSV file has been written successfully: team_cycle_data.csv');
    
    console.log(csvContent);
    
  } catch (error) {
    console.error('Error:', error.message);
  }
};

main();
