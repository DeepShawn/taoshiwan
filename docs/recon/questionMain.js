/**
 * 分页
 */
function getPageData(data,paperBasketList){
     $.ajax({
    	 type:"post",
    	 url:"../../hw/question/queryQeustionByPage.do",
    	 data:data,
    	 error:function(result){
    		 layer.msg(result.responseText);
    	 },
    	 success:function(result){
    		 $("#total").text(result.total);
    		 layui.use(['laypage'],function(){
	             var laypage = layui.laypage;
	             laypage({
	                     cont: 'pageBox',
	                     pages: Math.ceil(result.total / data.pageSize), //得到总页数
	                     groups: 3,
	                     curr:data.pageIndex,
	                     skip:true,//设置是否显示调到第几页-默认为false
	                     skin: '#1E9FFF',//设置按钮选中颜色
	                     jump: function (obj,first) {
	                         document.getElementById('pageList').innerHTML = render(result,paperBasketList);
	                         if(!first){
	                        	 data.pageIndex = obj.curr;
	                        	 getPaperBasketList();
	                         }
	                     }
	                 }); 
	             });
    	 }
    	 
     });
}
function getPaperBasketList(){
	 $.ajax({
    	 type:"post",
    	 url:"../../hw/tiku/getBasketList.do",
    	 data:{},
    	 error:function(result){
    		 layer.msg(result.responseText);
    	 },
    	 success:function(result){
    		 getPageData(data,result)
    	 }
     });
}
//渲染pageList
function render (result,paperBasketList) {
    var arr = []
            , thisData = result.rows;
    layui.each(thisData, function (index,item) {
    	var flag = false;
        arr.push('<li>'+
        		 '<div class="testTitle">'+
			        '<div class="fl mr5">【题型】'+item.questionTypeName+'</div>'+
			        '<div class="fl mr5">【年级】'+item.gradeName+'</div>'+
			        '<div class="fl mr5">【教材】'+item.bookVersionName+'</div>'+
			       /* '<div class="fl mr5">【知识点】'+item.knName+'</div>'+*/
			        '<div class="fl mr5">【更新日期】'+item.cdate+'</div>'+
			      '</div>'+
			      '<div class="testCont">'+
	                 '<div class="timu">'+
	                   '<p><h5>'+item.field01+'</h5></p>'
	                   );
        if(item.options.length>0){
        	arr.push('<ul class="choose-list">');
        	for(var i=0;i<item.options.length;i++){
        		arr.push(
        				"<li>"+item.options[i].field03+"."+item.options[i].field01+"</li>"
        		);
        	}
        	arr.push("</ul>");
        }
        arr.push(" </div>");
        arr.push(
	        '<div class="info">'+
		        '<div class="fl">');
        if(paperBasketList!=null && paperBasketList!='undefined'){
	        for(var i=0;i<paperBasketList.length;i++){
	        	if(paperBasketList[i].field02 == item.rec_id){
	        		 arr.push('<a class="text-primary mr10" href="javascript:void(0);" onclick="moveOutBasket(\''+item.rec_id+'\',\''+item.field05+'\');"><i class="icon icon-plus"></i>移出试题篮</a>');
	        	     flag=true;
	        	}
	        }
        }
        if(!flag){
    		arr.push('<a class="text-primary mr10" href="javascript:void(0);" onclick="putInBasket(\''+item.rec_id+'\',\''+item.field05+'\');"><i class="icon icon-plus"></i>移入试题篮</a>');
    	}
	  
        if(item.users_id === user_id){
        	arr.push(  '<button class="btn btn-xs btn-primary mr10" onclick="editQuestion(\''+item.field05+'\',\'3\',\''+item.rec_id+'\');">编辑</button>');
        }
        //arr.push('<button class="btn btn-xs btn-warning mr10" onclick="editQuestion(\''+item.field05+'\',\'2\',\''+item.rec_id+'\');">改编</button>');
        if(item.users_id === user_id){
        	arr.push(   '<button class="btn btn-xs btn-danger" onclick="delQuestion(\''+item.rec_id+'\')">删除</button>');
        }
       arr.push(
		    	'</div>'+
		    	 '<div class="fr"> 【难度】 '+item.difStar+' </div>'+
			  '</div>'+
		 '</div>'+
		'</li>');
        arr.push('<input type="hidden" name="questionAndType" value=\''+item.rec_id+'_'+item.field05+'\' />');
    });
    return arr.join('');
};

function delQuestion(questionId){
	var idx = layer.confirm('是否删除该试题?', {icon: 3, title:'提示'}, function(index){
		$.ajax({
			   type:"POST",
			   url:"../../hw/question/deleteQuestionById.do",
			   dataType:"json",
			   data:{"questionId":questionId},
			   async:false,
			   error:function(result){
				   layer.msg(result.message);
			   },
			   success:function(result){
				   //location.href="../question/main.do";
				   getPageData(data);
				   layer.close(idx);
			   }
		   });
   });
	
}
