// basket.js - Quote Basket System for Yorktown Tools
// Uses localStorage to remember items across pages

const BASKET_KEY = 'yorktownQuoteBasket';

function getBasket() {
    const data = localStorage.getItem(BASKET_KEY);
    return data ? JSON.parse(data) : [];
}

function saveBasket(basket) {
    localStorage.setItem(BASKET_KEY, JSON.stringify(basket));
}

function addToBasket(itemName, quantity = 1) {
    if (!itemName || itemName.trim() === '') return;
    
    const basket = getBasket();
    const existing = basket.find(i => i.name === itemName.trim());
    if (existing) {
        existing.qty += quantity;
    } else {
        basket.push({ name: itemName.trim(), qty: quantity });
    }
    saveBasket(basket);
    updateBasketUI();
}

function clearBasket() {
    localStorage.removeItem(BASKET_KEY);
    updateBasketUI();
}

function updateBasketUI() {
    const basket = getBasket();
    const count = basket.reduce((sum, i) => sum + i.qty, 0);
    
    document.querySelectorAll('.basket-count').forEach(el => {
        el.textContent = count;
        el.style.display = count > 0 ? 'flex' : 'none';
    });
    
    // Also update the button text if needed
    document.querySelectorAll('#quote-basket-btn').forEach(btn => {
        btn.querySelector('span').textContent = count;
    });
}

// Create the floating "Get Quote" basket button
function createBasketButton() {
    if (document.getElementById('quote-basket-btn')) return;

    const btn = document.createElement('div');
    btn.id = 'quote-basket-btn';
    btn.innerHTML = `
        <span class="basket-count" style="display:none;">0</span>
        Get Quote
    `;
    btn.style.cssText = `
        position: fixed;
        right: clamp(16px, 4vw, 24px);
        bottom: calc(clamp(72px, 16vw, 88px) + 20px);
        background: var(--red);
        color: white;
        padding: 16px 24px;
        border-radius: 50px;
        font-weight: 700;
        font-size: 1.15rem;
        box-shadow: 0 8px 30px rgba(200,16,46,0.5);
        z-index: 998;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 10px;
        transition: var(--transition);
    `;

    const countSpan = btn.querySelector('.basket-count');
    countSpan.style.cssText = `
        background: white;
        color: var(--red);
        min-width: 28px;
        height: 28px;
        border-radius: 50%;
        font-size: 1rem;
        font-weight: 800;
        display: flex;
        align-items: center;
        justify-content: center;
    `;

    btn.onclick = () => {
        const basket = getBasket();
        if (basket.length === 0) {
            alert("Your quote basket is empty!");
            return;
        }

        // For small baskets (≤5 items), send via SMS with clean, readable newlines
        if (basket.length <= 5) {
            const itemsText = basket.map(i => `• ${i.name} ×${i.qty}`).join('\n');
            const smsBody = `Quote Request from YorktownTools.com\n\n${itemsText}\n\nPlease send pricing, availability, and delivery options. Thank you!`;
            
            // Use plain \n newlines — modern phones (iOS & most Android) display them correctly as line breaks
            window.location.href = `sms:7579405171?body=${smsBody}`;
        } else {
            // For larger baskets, go to main page and pre-fill the form
            window.location.href = 'index.html?basket=1';
        }
    };

    document.body.appendChild(btn);
    updateBasketUI();
}

// Auto-fill the quote form on index.html if coming from basket
function autoFillQuoteForm() {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('basket')) return;

    const basket = getBasket();
    if (basket.length === 0) return;

    const container = document.getElementById('item-list');
    if (!container) return;

    // Clear the default single row
    container.innerHTML = '';

    basket.forEach(item => {
        const row = document.createElement('div');
        row.className = 'item-row';
        row.innerHTML = `
            <input type="text" name="item_name[]" value="${item.name.replace(/"/g, '&quot;')}" class="item-name" readonly>
            <input type="number" name="quantity[]" value="${item.qty}" min="1" class="item-qty">
            <button type="button" class="remove-item" onclick="this.parentElement.remove()">X</button>
        `;
        container.appendChild(row);
    });

    // Scroll to the form
    document.querySelector('#contact').scrollIntoView({ behavior: 'smooth' });

    // Optional: clear URL parameter
    history.replaceState({}, '', 'index.html');

    // Optional: clear basket after filling (uncomment if desired)
    // clearBasket();
}

// Initialize everything when page loads
document.addEventListener('DOMContentLoaded', () => {
    createBasketButton();

    // Only run auto-fill on the main page
    if (window.location.pathname.endsWith('index.html') || 
        window.location.pathname === '/' || 
        window.location.pathname === '/index.html') {
        autoFillQuoteForm();
    }

    updateBasketUI();
});
