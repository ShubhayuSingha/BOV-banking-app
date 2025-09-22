// // Event listeners for navbar buttons
// document.getElementById('nav-employeeLogin').addEventListener('click', function(){
//     window.location.href = '#employeeLogin';
//   });
//   document.getElementById('nav-adminLogin').addEventListener('click', function(){
//     window.location.href = '#adminLogin';
//   });
//   document.getElementById('quick-signup').addEventListener('click', function(){
//     window.location.href = '#signup';
//   });
  
  document.addEventListener("DOMContentLoaded", function() {
    fetch('transactions.json')
      .then(response => response.json())
      .then(transactions => {
        const container = document.querySelector('.transactions-container');
        transactions.forEach(transaction => {
          const box = document.createElement('div');
          box.classList.add('transaction-box');
          // Add class based on credit or debit
          if (transaction.type.toLowerCase() === 'credit') {
            box.classList.add('credit');
          } else {
            box.classList.add('debit');
          }
          // Create inner HTML with all details including time
          box.innerHTML = `
            <span class="trans-account">Acc: ${transaction.account}</span>
            <span class="trans-name">${transaction.name}</span>
            <span class="trans-date">${transaction.date} ${transaction.time}</span>
            <span class="trans-type">${transaction.type}</span>
            <span class="trans-amount">${transaction.amount}</span>
          `;
          container.appendChild(box);
        });
      })
      .catch(error => console.error('Error fetching transactions:', error));
  });
  
  document.addEventListener("DOMContentLoaded", function() {
    const videoPlayer = document.querySelector('.video-panel video');
    if (videoPlayer) {
      videoPlayer.volume = 0.2; // Set volume to 50%
    }
  });
  